# Let one named reminder through quiet hours

Part of #3145. Base: integration/scheduled-proactive. Status: tasks 1 and 3 implemented; delivery waits for #3479.

## Outcome and scope

An owner can allow or stop allowing one existing reminder during quiet hours in Main chat.
Settings, Alerts & quiet hours lists the saved allowances and offers Change in chat.
Other reminders still wait. Module mutes, device switches and channel preferences still win.
The existing chat result remains readable immediately and is never recreated for an alert.
No global urgency bypass, new channel, task editor or unsupported watch capability is added.

Source: the approved scheduled/proactive spec, sections Ordinary-chat creation and approval,
Usefulness and attention, Alerts & quiet hours Settings, and acceptance scenarios 7, 13 and 17.
The task brief supplies the later owner-typed agreement rule from #3135.

## Current seams, verified on the integration base

> 🧠 **From Hindsight memory (Reminder notifications (#3134))** — reminder delivery and outward alerts use separate paths, and push workers recheck source state. The current files below confirm those seams; the page's past PR status is not used as current status.

| Capability                                       | Current evidence                                            | Change                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Raw owner request before the model               | packages/chat/src/live/pre-model-turn.ts:32                 | Recognize allowance commands here, including a typed response to a stored proposal. Keep the module-control refusal. |
| Transactional deterministic chat acknowledgement | packages/chat/src/live/persistence.ts:516 and :568          | Reuse the reminder command transaction and save callback after the user message exists.                              |
| Command registry                                 | packages/chat/src/reminders/commands/registry.ts:7          | Add the allowance handler and its recognizer.                                                                        |
| Owner-scoped reminder matching                   | packages/chat/src/reminders/cancel.ts:99                    | Reuse normalization, but never choose the first of multiple matches.                                                 |
| Durable chat result before outward job           | packages/chat/src/reminders/deliver.ts:112                  | Leave this path alone.                                                                                               |
| Separate outward reminder creation               | packages/chat/src/reminders/notifications.ts:48             | Read current allowance without assigning urgent status.                                                              |
| Initial quiet-hours hold and queue choice        | packages/notifications/src/repository.ts:323 and :404       | Add an optional public policy check beside the hold.                                                                 |
| Push-time source and mute checks                 | packages/notifications/src/push-worker.ts:360               | Add allowance evaluation beside the quiet-hours check, separately from the source lifecycle check.                   |
| Runtime composition                              | packages/module-registry/src/index.ts:2131, :2145 and :2390 | Wire the chat public policy into creation and both push workers.                                                     |
| Settings layout and canonical editor             | apps/web/src/settings/settings-alerts-pane.tsx:128          | Add a read-only allowance group below the editor.                                                                    |
| Authenticated task list                          | packages/chat/src/reminders/routes.ts:16                    | Add an owner-scoped read endpoint for allowance records; no model-callable mutation endpoint.                        |
| Persistent reminder schema                       | packages/db/src/types.ts:1026                               | Add separate table types, leaving existing reminder columns and lifecycle triggers alone.                            |
| Existing real-browser push proof                 | tests/uat/specs/3134-reminder-notifications.uat.spec.ts:18  | Reuse the persistent browser, actual service worker and real-model sign-in patterns.                                 |

The graph does not expose the recent reminder command definitions reliably. Bounded source reads
were used to establish the current seams. The branch was fetched and rebased before delivery planning.

## Quiet-hours storage ruling

The issue's migration recommendation is resolved by the approved
docs/superpowers/plans/2026-10-08-scheduled-proactive-migration-decisions.md, Canonical quiet hours.
Profile remains canonical. The existing authority reader at
packages/settings/src/quiet-hours-authority.ts:202 preserves unresolved consumer policies.
This slice neither migrates nor modifies schedules, defaults, timezones or conflict resolution.
An allowance is a separate task-bound record, not a change to the Profile schedule.

Use assigned migration packages/chat/sql/0314_chat_quiet_hours_allowances.sql and register it in
packages/chat/src/manifest.ts. Do not touch migration 0313 or its pause/delete columns.

Proposed table contracts:

```sql
CREATE TABLE app.chat_reminder_quiet_allowances (
  reminder_id uuid PRIMARY KEY REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL REFERENCES app.chat_messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.chat_reminder_quiet_proposals (
  thread_id uuid PRIMARY KEY REFERENCES app.chat_threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  reminder_version integer NOT NULL,
  allow boolean NOT NULL,
  source_message_id uuid NOT NULL REFERENCES app.chat_messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Enable and force owner-only RLS on both tables. Policies also require the referenced reminder,
thread and source user message to belong to the current actor; source messages must have user role.
Grant app runtime the required select/insert/delete privileges; proposals are replaced by delete
and insert. Grant workers select only. No admin bypass, default allowance, urgency backfill or
private text in queue payloads. Removing a reminder cascades its allowance and pending proposal.

Separate storage avoids rewriting the immutable reminder update trigger and colliding with #3479.
A boolean on the reminder would be smaller to read, but requires expanding both the update trigger
and owner update policy being changed by that lane. Separate tables keep this change bounded.

## Owner agreement and deterministic behavior

Direct command examples: Allow the reminder to stretch during quiet hours; Stop allowing the
reminder to stretch during quiet hours. A bounded recognizer reads only the raw authenticated
owner turn. One exact normalized task title is direct agreement. No match saves nothing.
Multiple matches name the candidates and ask the owner to identify one, without saving an allowance.
A unique partial match is interpreted: code stores the exact task, version and allow/remove action,
then asks an ordinary chat question naming that task. Only a subsequent raw typed yes applies it.
Duplicate identical titles require an explicit task identifier rather than selecting by time.

The proposal is bound to the owner and Main thread. Typed no, unrelated turns and changed requests
clear it. A yes with no pending proposal changes nothing. Before acceptance, re-read the task and
version under the existing reminder notification lock. Missing, cancelled, expired, failed or
paused tasks cannot acquire an allowance. Removal remains possible for a surviving saved allowance.
Store the source user message ID for direct commands or accepted yes, not assistant text.
Module-controlled, incognito and foreign-thread turns cannot authorize an allowance.
Never parse an assistant response, retrieved content, urgency label or tool arguments as consent.

All questions, refusals and saved acknowledgements are produced by code from records in the existing
host reminder turn. Settings renders the records returned by its read endpoint. No module injects
host turns. The model's two jobs remain ordinary conversation and explaining supported controls;
it does not choose the saved target or grant agreement. No added prompt guidance is needed.

Public contracts:

- Chat exports isReminderNotificationAllowedDuringQuietHours(scopedDb, notification): Promise<boolean>.
- Notification infrastructure accepts an optional isAllowedDuringQuietHours callback at creation
  and push dispatch; missing callback means no exception. Non-chat notifications return false.
- GET /api/chat/quiet-hours-allowances returns only the current owner's saved task IDs and titles.
- Shared chat origin gains allowance saved, removed, proposed and refused events; validators and
  fixtures are updated with the contract. The read API gains its DTO and route schema.

The chat policy validates reminder metadata and saved result identity and reads the live allowance.
Both initial creation and dispatch consult it; an allowance must not be cached in notification
metadata or queue payloads. Do not promote urgency to reuse the existing urgent bypass.
Removal before queued dispatch restores current quiet-hours deferral. The source lifecycle check
still runs independently before the exception. Existing module/sensitivity/subscription checks
remain in place. Share the current reminder notification lock for allowance mutations and the
delivery read, so their ordering is explicit; preserve the existing bounded push-send timeout.

Adding an allowance changes future dispatch policy; it does not recreate the result or resend an
already delivered alert. A notification already waiting in the existing release queue uses the
current allowance when its queued attempt runs, without introducing a second scheduler.

## Build tasks and checks

1. Add the migration, table types and owner-only allowance/proposal repository in
   packages/chat/src/reminders/quiet-hours-allowances.ts. Add the command handler in
   packages/chat/src/reminders/commands/quiet-hours-allowance.ts and extend commands/types.ts,
   commands/registry.ts, commands.ts, turn.ts, live/pre-model-turn.ts and live/persistence.ts.
   Integrate clearing proposals into ordinary turn persistence. Extend shared chat origin parsing.
   Write failing behavior tests before implementation, then observe green.
2. Add the public chat policy to reminders/notifications.ts and src/index.ts. Extend
   packages/notifications/src/repository.ts, push-worker.ts and exports with the policy seam;
   wire packages/module-registry/src/index.ts. Rebase again before these shared delivery edits
   if #3479 has merged. Do not replace its paused-or-missing recheck.
3. Add the read API to reminders/routes.ts, shared contracts, web client and query keys.
   Create apps/web/src/settings/settings-quiet-hours-allowances.tsx using Group, Row, Note,
   Button and existing chat-opening navigation, wired below QuietHoursEditor in AlertsPane.
   Include loading, empty, load failure and retry. Change in chat opens ordinary Main chat.
   Refresh saved records on returning to Settings. Keep desktop columns and phone stacking.
   Update packages/shared/src/app-map-core.ts and packages/chat/src/manifest.ts with the actual
   supported commands, Settings location, muted-channel limits and error/remediation behavior.
4. Add tests/uat/specs/3145-quiet-hours-allowance.uat.spec.ts and rows in
   .claude/skills/coordinate/uat-trigger-map.tsv covering changed chat, notifications and Settings
   files. Build a disposable from-source install with a claimed dev port and image tag
   uat-sched-3145; use a real configured model and real push path. Post proof on the PR.

Required behavioral checks in tests/unit and tests/integration:

Add tests/unit/chat-reminder-quiet-hours-commands.test.ts and
tests/integration/chat-reminder-quiet-hours-allowances.test.ts. Extend
tests/unit/push-worker.test.ts, tests/unit/settings-alerts-pane.test.tsx,
tests/integration/chat-reminder-notifications.test.ts and
tests/integration/chat-reminders-permissions.test.ts. Update origin parsing in
packages/chat/src/route-serializers.ts alongside the shared schema and its existing tests.

- Exact owner command adds/removes only the named task; repeated commands are harmless.
- Unique partial target asks once and saves nothing until typed yes; no, unrelated turn,
  changed action, stale version and ambiguous duplicate title save nothing.
- Bare yes, assistant-produced approval, module-control input and source instructions cannot
  create a saved allowance. Two owners and an admin cannot read or mutate another owner's rows.
- A real Main turn writes its user source message and deterministic acknowledgement atomically;
  transaction rollback leaves no saved allowance or proposal.
- In a current quiet window, the allowed reminder alerts; the unallowed reminder waits.
  Initial queue selection and both individual/summary push workers exercise the production wiring.
- Removing an allowance before queued delivery defers it again; paused/missing/dismissed reminders
  remain blocked. Module mute, sensitivity and disabled device subscriptions still block delivery.
- Retrying a notification does not recreate chat, reset its read state or duplicate successful push.
- Settings lists only saved allowances, handles load failure/retry and opens Main chat.
- Security checks must be observed failing when their relevant enforcement is temporarily removed;
  restore enforcement and record the negative-control result in PR evidence.

Kill gate after task 1: the command-to-record integration test must demonstrate owner-only typed
agreement and rollback with no model participation. If this needs a new generic approval framework
or unsupported scheduler, stop and ask the coordinator to reslice before proceeding.

Verification commands, all expected exit 0 and unpiped:

```bash
pnpm format:check
pnpm lint
pnpm check:file-size
pnpm typecheck
pnpm check:ui-classes
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

The gate wait runs as one detached/background command. Unit and integration behavior tests are
added to their existing suites and run through the full isolated gate. Read CI on the eventual
PR; local foundation does not include browser CI. Use the existing UAT harness for the new spec,
with assertions on actual browser notifications and saved records, no network response rewriting.

Live proof must allow one reminder in a current quiet window alongside an unallowed reminder,
remove the allowance, then repeat with the existing device channel muted. Show Settings updates,
the unchanged chat message count, actual notification outcomes, desktop/phone and light/dark/Teal
states. Stop owned containers/browser processes and release the port afterwards.

## Review and closeout

Commit by explicit paths. Before push run the cheap checks and fetch/rebase the integration base,
never main. Push this branch and open the PR against integration/scheduled-proactive with
Part of #3145 and release-note Category: N/A. Post live proof and negative-control evidence.
If live proof is unavailable, report code-complete, unverified. Read CI, clean the worktree and
report the PR to the coordinator. No merge, board changes or milestone changes.

## Rulings and open approvals

- Coordinator owns plan approval, including separate storage and the interpreted-target yes flow.
- Migration 0314 is assigned by the brief; 0313 belongs to the parallel task-control lane.
- Canonical quiet-hours storage is already settled by the approved migration decisions.
- Task lifecycle policy will be rebased onto #3479 if it lands before delivery edits.
- Coordinator approved commit 714e14fc1. Accept everyday allowance phrasings, leave unmatched requests to normal chat, and rebase on integration before task 2 regardless of #3479 status. If #3479 is not merged, request sequencing before delivery edits.

## Task 1 evidence and review ledger

- The command wording tests were observed red before implementation (15 failures), then green.
- Focused unit checks passed 108 tests, including bare yes falling through without a proposal and module-control refusal.
- The isolated task 1 gate passed 32 integration/catalog tests before the final extra edge cases were added.
- Negative control: disabling the raw typed-command guard and removing the source user-role predicate produced exactly two failing integration tests. Both protections were restored before further work.
- The initial app-map declaration exceeded the 240-character description limit; it was shortened. Adding the declaration also crossed the 1000-line manifest limit. Reminder feature declarations now live together in packages/chat/src/reminders/features.ts; the original values are preserved.
- Added test:integration:3145 to package.json so the prescribed isolated gate can run this phase's named kill gate without running unrelated integration suites.
- A final fresh task 1 gate and static checks are required after the remaining version/removal assertions; the full foundation gate and live proof remain required for the finished slice.

> 🧠 **From Hindsight memory (Conventions and patterns)** — hidden UPDATE/DELETE operations may affect zero rows rather than throw; the owner-isolation check therefore asserts zero deleted rows and unchanged owner data. The isolated integration run verified that behavior here.

- Final task 1 isolated gate passed 34 tests on restored protections. Root and test TypeScript checks and file-size check passed.
- Coordinator ordering ruling: commit task 1, build task 3, and hold delivery files until the coordinator reports #3479 merged. Rebase on integration before task 2.

## Task 3 evidence and current hold

- Settings tests first failed on the missing component; endpoint tests first failed with 404s before route wiring. With wiring present, six Settings unit tests and the 40-test isolated integration/catalog/API gate passed.
- The read response includes the owner Main thread ID alongside saved task IDs and titles, so Change in chat can open Main explicitly without sending a message or inheriting an active side chat.
- No delivery files changed. The app map describes saved choices and marks device delivery support pending until task 2 ships.
- Full pre-push formatting, lint and typecheck passed (including root, test, web and external modules). UI-class and file-size checks passed. The full foundation gate, installed UI proof and delivery checks remain pending.
- Hold task 2 until the coordinator sends the #3479 merge SHA, then rebase on integration and add the separately approved exception beside its lifecycle recheck.
