# Repeating fixed-text reminders - build plan

Part of #3136. Base: integration/scheduled-proactive. Risk: sensitive.
Approved product spec: ../specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md,
Ordinary-chat creation, Responsibilities and user controls, and Recovery and lifecycle.

## Status and scope

Plan 4a1c97a0f approved by the coordinator on 2026-10-12 with the rulings below. Work stays in
~/Jarv1s/.claude/worktrees/sched-3136-repeating, on scheduled/3136-repeating-reminders.
Migration assignment: 0319. No applied migration changes.

One phase delivers daily, weekly and more-often fixed reminders, their chat edits,
Settings groups, and real worker-downtime proof. No source reads, model execution
at firing time, novelty scoring, destination changes, or unrelated follow-ups.
The existing implementation already supplies creation, local clocks, row locks,
version checks, pause/resume/delete, result persistence and notifications; it does
not supply recurring storage, repeated result identities, or grouped recurring rows.

## Verified seams

These citations were checked on this worktree, rather than inherited from the old
spec baseline. The graph has older symbols but lacks the current reminder paths.

| Capability                        | Current evidence                                                                                            | Use                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Transactional enqueue             | packages/chat/src/reminders/deliver.ts:62                                                                   | Every enqueue uses enqueueReminderDelivery, including the next firing.                                   |
| Row lock and version checks       | packages/chat/src/reminders/deliver.ts:76                                                                   | Serialize delivery with controls; reject old jobs before effects.                                        |
| Persisted result and live arrival | packages/chat/src/reminders/deliver.ts:109                                                                  | Keep message, run, next job and arrival in one transaction.                                              |
| Retry exhaustion                  | packages/chat/src/reminders/deliver.ts:153                                                                  | Preserve bounded retry and final failed state.                                                           |
| Owner cap                         | packages/chat/src/reminders/commands/save.ts:16; packages/chat/sql/0313_chat_reminder_controls.sql:6        | Preserve the 20-slot cap, including paused schedules.                                                    |
| Timezone conversion               | packages/chat/src/reminders/local-clock.ts:37; packages/module-sdk/src/time.ts:327                          | Reuse strict local conversion and local-day arithmetic.                                                  |
| Existing cron helper              | packages/shared/src/recurring-schedule.ts:4                                                                 | Briefing-specific fallback is unsuitable for validated reminder terms; do not reuse its silent defaults. |
| Control serialization             | packages/chat/src/reminders/controls.ts:19                                                                  | Reuse notification advisory lock and reminder row lock.                                                  |
| Edit validation and save          | packages/chat/src/reminders/edit.ts:35; packages/chat/src/reminders/edit.ts:105                             | Extend existing complete field diff and expected version.                                                |
| Model edit boundary               | packages/chat/src/reminders/prepare-edit.ts:24                                                              | Keep model interpretation outside the transaction and validate on save.                                  |
| Main context acknowledgement      | packages/chat/src/reminders/repository.ts:257                                                               | Preserve acknowledgement by exact persisted message ID.                                                  |
| Notification identity             | packages/chat/src/reminders/notifications.ts:25                                                             | Keep one result identity per firing, including quiet-hours holds.                                        |
| Settings and public contract      | packages/chat/src/reminders/settings.ts:63; packages/shared/src/scheduled-tasks-api.ts:23                   | Add cadence and repeated run history to the same records.                                                |
| Authored UI                       | apps/web/src/settings/scheduled-task-list.tsx:43; apps/web/src/settings/scheduled-task-details/timing.tsx:5 | Reuse SectionHead, RowIndex and existing details/controls.                                               |
| Migration registration            | packages/chat/src/manifest.ts:85; tests/integration/foundation-schema-catalog.test.ts:631                   | Register assigned migration in both places.                                                              |
| Disposable real chat              | tests/uat/provisioned-run.ts:36; tests/uat/real-chat-env.ts:78                                              | Existing claimed-port stack, Codex sign-in helper and teardown.                                          |
| Isolated resident worker          | scripts/start-jarv1s.ts:198                                                                                 | Suspend and resume only this disposable stack's worker PID for downtime proof.                           |

## Schedule decisions for coordinator approval

- Daily means one saved local clock time each local day. Weekly means that clock
  time on the saved weekday. Save the owner's resolved timezone; later profile
  changes do not silently move an existing schedule.
- More often means a fixed elapsed interval of 60 through 86399 seconds, starting
  one interval after creation unless the owner supplies a valid future start.
  Hourly is 3600 seconds. Refuse shorter intervals instead of allowing a chat flood.
- Daily/weekly creation requires a clock time, weekly also requires a weekday.
  Missing or ambiguous terms save nothing and explain what to supply.
- Approved DST policy: advancing a saved daily/weekly schedule shifts a missing
  spring time forward by the gap (02:30 becomes 03:30 for a one-hour gap). A fall
  fold fires once at its earlier occurrence. Keep strict conversion for creation
  and edits; use a separate resolver only for advancement. State the rule plainly
  in details, not in confirmation. Test both transitions before delivery code.
- Downtime or resume after an overdue time delivers one catch-up result. Calculate
  the next occurrence strictly after database now from the saved cadence, not
  from the completion time. Never iterate or enqueue missed occurrences.
- A recurring deadline is an absolute stop time. Preserve one-time reminders'
  existing 12-hour deadline validation; recurring stops can span several cycles.
  Skip an overdue delivery after the stop. If a successful firing has no further
  eligible occurrence before the stop, finish that schedule as completed.
- Explicit start/repeat/deadline edits retain the same schedule ID and invalidate
  its queued version. Text-only edits preserve cadence. Removing repetition turns
  the pending next occurrence into a one-time reminder.

## Storage and execution contract

Add packages/chat/sql/0319_chat_repeating_reminders.sql. Add nullable repeat_kind
and repeat_seconds to app.chat_reminders; existing rows keep null and their current
behavior. Daily/weekly use existing local_due/time_zone as the current occurrence's
local anchor. Interval uses the existing due_at and delay_seconds as the anchor.

DDL decisions:

```sql
ALTER TABLE app.chat_reminders
  ADD COLUMN repeat_kind text CHECK (repeat_kind IN ('daily', 'weekly', 'interval')),
  ADD COLUMN repeat_seconds integer,
  ADD CONSTRAINT chat_reminders_repeat_shape CHECK (
    (repeat_kind IS NULL AND repeat_seconds IS NULL)
    OR (repeat_kind IS NOT NULL AND repeat_kind IN ('daily', 'weekly') AND timing = 'local_clock'
      AND repeat_seconds IS NULL)
    OR (repeat_kind IS NOT NULL AND repeat_kind = 'interval' AND timing = 'relative'
      AND repeat_seconds BETWEEN 60 AND 86399
      AND repeat_seconds IS NOT NULL)
  );

CREATE TABLE app.chat_reminder_runs (
  id uuid PRIMARY KEY,
  reminder_id uuid NOT NULL REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  due_at timestamptz NOT NULL,
  at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'expired')),
  message_id uuid UNIQUE REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  late boolean NOT NULL,
  context_state text NOT NULL DEFAULT 'pending'
    CHECK (context_state IN ('pending', 'acknowledged', 'dismissed')),
  UNIQUE (reminder_id, version),
  CHECK ((outcome = 'delivered') = (message_id IS NOT NULL))
);
CREATE INDEX chat_reminder_runs_history_idx
  ON app.chat_reminder_runs(reminder_id, at DESC);
```

Update the deadline constraint to allow recurring absolute stops while retaining
the one-time rule. In SQL, explicitly reject malformed recurrence combinations,
invalid first/next instants and changes to result identities outside advancement.
Use IS NULL-aware checks: PostgreSQL CHECK cannot rely on null comparisons to
reject an invalid combination.

Force RLS on the new run table. Owner SELECT requires the same accessible reminder
and thread. Worker INSERT must match the locked queued reminder's owner, version,
due time and reserved stored assistant message; expiry must have no message and
must be past the saved stop. Owner UPDATE grants only context_state, permitting
pending to acknowledged/dismissed. No owner ability to fabricate runs or messages.
Run terms and result identity are immutable. Delete cascades run metadata, never
chat messages. Verify grants and triggers through negative DB tests.

Extend the existing reminder insert/update triggers in the new migration only.
Allow one worker transition from queued to queued with version + 1, a fresh
reserved_message_id and strictly future due time only after its current run and
message were persisted. Preserve schedule identity, source, owner and terms.
Keep the one-time delivered/expired/failed transitions, owner terms edits, and
pause/resume guards. Add only the runtime column grants needed for repeat edits.
The worker UPDATE policy must admit validated queued advancement.

Each recurring firing inserts its reserved message, inserts one run, advances the
same reminder to the next eligible due/version/message identity, and enqueues that
one next job inside the same transaction. It retains queued state while active;
delivered_at/late stay null on an active record. Final completed/expired records
retain the current terminal field invariants. A rollback leaves no partial result
or next job; a duplicate old job sees a stale version. Hold the same notification
lock ordering as controls before the row lock to avoid opposing lock orders.

Keep one-time history fallback without migrating previously delivered records.
For recurring context and history, use the new immutable runs. Acknowledge only
the exact message IDs admitted to a successful Main turn. Notification lookup
accepts the payload's exact message ID and run version, so advancement cannot
discard a held prior result. Pause/cancel/delete continue suppressing future
interruptions under the existing lifecycle policy. Quiet-hours allowances remain
attached to the schedule ID, checked again for each exact result.

## Files, interfaces and determinism

- packages/shared/src/chat-api.ts: export ReminderRepeat as daily/weekly or interval
  with seconds; extend ReminderEditTerms with repeat change (keep/set/remove).
  Preserve stored older edit proposals by normalizing missing repeat to keep.
- packages/chat/src/reminders/repeating.ts: pure next-occurrence calculation using
  existing SDK date helpers; typed input/return include dueAt, localDue, timezone
  and nullable stop. No dependency or cron scheduler added.
- packages/chat/src/reminders/repeat-recognizer.ts and commands/repeat-request.ts:
  bounded ordinary-chat recognition and deterministic preparation. Wire through
  recognizer.ts, commands/types.ts, commands/registry.ts and turn.ts. Match explicit
  reminder requests only, keeping timing phrases separate from inert message text.
  Examples: remind me every day at 9am to stretch; remind me every Monday at 9am to
  water plants; remind me every 2 minutes to stand up. Equivalent text-first forms
  and hourly/daily/weekly terms get targeted coverage. Monthly and unclear repeats
  remain refused, with truthful supported alternatives.
- packages/chat/src/reminders/repository.ts, deliver.ts: recurrence/run fields,
  transactionally persisted next occurrence and existing enqueue path. Add a
  focused run repository file if needed to keep separate responsibilities readable.
- packages/chat/src/reminders/edit.ts, edit-interpretation.ts, prepare-edit.ts,
  commands/edit.ts and edit-agreement.ts: repeat edits and confirmations; strict
  validation, existing ambiguous-target selection and stale version refusal.
- packages/chat/src/reminders/controls.ts, notifications.ts and cancel.ts:
  preserve shared locks, exact result lookup and controls after multiple firings.
- packages/db/src/types.ts, packages/chat/src/manifest.ts and the schema catalog:
  typed table/columns and migration registration.
- packages/chat/src/reminders/settings.ts, packages/shared/src/scheduled-tasks-api.ts:
  groups Reminders/Daily/Weekly/More often, cadence description, saved timezone,
  next due and at most the latest 20 runs per task. No private run bodies in Moss's
  grant-backed metadata reads.
- apps/web/src/settings/scheduled-task-list.tsx and scheduled-task-details/timing.tsx:
  render only populated groups, saved cadence/timezone and next run from records;
  preserve Past tasks, history, safe delete focus and chat-only editing. Coordinate
  rebases with #3148; its destination row is outside this lane.
- packages/shared/src/app-map-core.ts and packages/chat/src/reminders/features.ts,
  manifest.ts: correct unavailable-repeat claims; declare cadence, limits, DST,
  catch-up, editing, expiry errors and recovery in the same PR.
- .claude/skills/coordinate/uat-trigger-map.tsv: add the new blocking recurring UAT.

All saved/edited/delivered wording and UI feedback is code-written from validated
records. Creation and background delivery use no model. The existing edit model
has exactly two jobs: identify the named reminder; extract requested inert terms.
Keep guidance under 150 words with a repeat edit example, schema descriptions,
boundary validation, and complete before/after diff validation at save. It cannot
choose new actions, recipients, destination, or interruption permissions.

## Checks and live proof

Before delivery code, tests define DST behavior: shifted spring gap, earlier fall fold, 23/25-hour
days, weekly transition, midnight, and a timezone different from the server.
Unit cases cover interval phase preservation and multi-day downtime producing one
catch-up and a strictly future next due. Recognizer negatives include ordinary
sentences mentioning days/weeks, recall questions, and reminder text mentioning
daily vitamins. Edit tests cover text-only preservation, repeat changes, invalid
combinations, ambiguous selection, and old stored proposals.

Add tests/integration/chat-reminders-repeating.test.ts with real queue/DB coverage:
two deliveries have different message IDs but one schedule; retries and concurrent
workers produce one run/job; edit/pause/delete invalidate queued versions; resume
catches up once; expiry blocks a missed run; wrong owner/admin and fabricated run
inserts are denied. Observe the key authority negatives failing with enforcement
removed, then restore it. Exercise pending context and held notification from an
earlier occurrence after later advancement. Run existing reminder regressions too.

Add tests/uat/specs/3136-repeating-reminders-real.uat.spec.ts. Use the existing
disposable UAT harness and real-chat-env Codex sign-in cleanup; economy model is
selected through the shared real-chat helper. Claim with devports claim sched-3136
and build with JARVIS_IMAGE_TAG=uat-sched-3136. Do not reuse moss-proof or copy
Claude login. Set JARVIS_UAT_CLAIMED_WEB_PORT to the actual claimed port.

Through the real composer, first run a real model turn and an ordinary sentence
about days/weeks. Create daily, weekly and a one-minute reminder. Verify groups,
saved local clock/cadence, editing, and detail history at desktop and phone widths
in light, dark and Teal. Capture the disposable worker's exact PID from its process
arguments, suspend it for multiple intervals, then resume that same PID in finally.
The API/browser remain running. Assert one catch-up message and one future queued
occurrence, then the next normal firing; cancel in chat and verify no further run.
Never intercept or rewrite network responses. Preserve bounded textual assertions
for the PR comment; crop any screenshot before viewing it.

Kill gate: if deterministic repeat recognition intercepts ordinary chat, or the
real economy model cannot make a repeat edit after one prompt correction, stop and
report to the coordinator for a narrower slice. Do not extend prompts repeatedly.
If the complete slice exceeds the session budget, ask the coordinator to split
daily/weekly from more often before continuing.

Verification commands are unpiped; expected success is exit 0:

- pnpm exec vitest run tests/unit/chat-reminder-repeating.test.ts plus touched reminder unit suites.
- scripts/run-gate.sh start --gate test:integration; scripts/run-gate.sh wait --follow
  (one detached wait, using the isolated database).
- pnpm exec tsx tests/uat/run-uat.ts 3136-repeating-reminders-real.uat.spec.ts
  with the claimed port and unique image tag above.
- pnpm format:check; pnpm lint; pnpm typecheck; pnpm check:file-size; pnpm check:ui-classes.
- scripts/run-gate.sh start; scripts/run-gate.sh wait --follow for the final full gate.

Before every push, fetch/rebase origin/integration/scheduled-proactive and run the
cheap format/lint/typecheck trio. Open the PR against integration/scheduled-proactive,
use Part of #3136 and Release note Category: N/A. Read CI, post real proof or
honestly report code-complete, unverified. Remove scratch output, stop owned
resources by PID, release the claimed port, and report the PR to the coordinator.
No merge, board, milestone or docs/coordination changes.

## Review ledger

Coordinator approved the 60-second minimum and full scope. Rejected skipping DST
occurrences; the rule is shift forward by the gap and use the earlier fold once.
Lane #3148 will rebuild migration 0320 on top of 0319; this lane must preserve
thread and destination checks. If the session runs short, finish daily/weekly with
a PR open and report the remaining more-often work.
