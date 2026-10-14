# Edit saved reminders in chat - #3135

Status: approved by coordinator; implementation in progress. Branch: scheduled/3135-edit-reminders.
Base: integration/scheduled-proactive, verified at 97f776fbd.
Worktree: ~/Jarv1s/.claude/worktrees/sched-3135-edit-reminders.
Risk: sensitive. Assigned migration: 0317.

## Accepted scope

Part of #3135 and the approved scheduled-tasks spec dated 2026-10-07.
The issue comment dated 2026-10-12 records the ruling: AI fills in read-only
tasks; writes outside the reminder still require typed agreement.
Change one queued or paused reminder's text, local time or deadline through
ordinary owner chat. Confirm from the saved record. Settings reads that same
record, without an editor. Refuse changes to actions, recipients, destination,
recurrence or attention permissions. Preserve unrelated reminder fields.

## Verified seams and current gaps

| Capability                                               | Current source evidence                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pre-model owner command handling                         | packages/chat/src/live/pre-model-turn.ts:38                                                 |
| Command registry and deterministic replies               | packages/chat/src/reminders/commands/registry.ts:12; packages/chat/src/reminders/turn.ts:17 |
| Owner-scoped transactional turn persistence              | packages/chat/src/live/persistence.ts:564                                                   |
| Production persistence composition                       | packages/chat/src/live/runtime.ts:648                                                       |
| Provider-selected structured interpretation              | packages/ai/src/structured/generate-structured.ts:207                                       |
| Prepare model execution outside the transaction          | packages/ai/src/structured/generate-structured.ts:277                                       |
| Existing CLI structured adapter                          | packages/chat/src/live/cli-structured-adapter.ts:112                                        |
| Unique owner reminder matching                           | packages/chat/src/reminders/commands/control-target.ts:5                                    |
| Owner control lock and expected-version precedent        | packages/chat/src/reminders/controls.ts:19                                                  |
| Versioned metadata-only transactional enqueue            | packages/chat/src/reminders/deliver.ts:62                                                   |
| Worker state/version check, row lock through persistence | packages/chat/src/reminders/deliver.ts:87                                                   |
| Strict local-clock and deadline validation               | packages/chat/src/reminders/local-clock.ts:37                                               |
| Saved record exposed to Settings                         | packages/chat/src/reminders/settings.ts:52                                                  |
| Typed reply bound to the last stored owner turn          | packages/chat/src/reminders/delete-agreement.ts:11                                          |
| Database currently forbids terms edits                   | packages/chat/sql/0313_chat_reminder_controls.sql:21                                        |

The graph search returned no reminder symbols; bounded source discovery was
used instead. No editing command exists in the current registry. Delivery
already has the necessary version recheck; this lane will not change the
result-posting path or its shape. No stale spec premise requires a re-scope.

## Contracts and determinism boundary

The model has exactly two jobs: identify candidate reminders from the owner's
request and extract the requested text/time/deadline changes. It does not save,
confirm, select an ambiguous target, authorize effects or write visible replies.
Use the configured JSON-capable model through the existing AI router and CLI
adapter; do not hardcode a provider or model. Prepare the call with scoped
reads, release the transaction, run the model, then recheck on saving.

Add packages/chat/src/reminders/edit-interpretation.ts with a bounded schema
and validator. Terms include an optional replacement text, optional relative
delay or local wall-clock time, and a deadline operation of keep/set/remove.
Model candidate IDs must belong to the supplied owner-scoped pending records.
Reject unknown fields, invalid dates, overlong text, no-op empty edits and any
unsupported requested capability. A reminder containing words such as "delete
the file" remains inert reminder text; never route that text to an action tool.

Add the optional persistence port:
prepareReminderEdit(actorUserId: string, text: string, threadId: string,
signal?: AbortSignal): Promise<ReminderTurnPlan | undefined>.
Wire it in packages/chat/src/live/chat-session-ports.ts, persistence.ts,
runtime.ts and pre-model-turn.ts. A bounded edit-intent recognizer owns the
entry point before save recognition, so "move my reminder" cannot create a
new reminder. Unrelated chat continues through the existing gate. Failures
produce an honest unchanged result. Module-controlled, attachment-derived,
side-chat and incognito requests cannot edit through this owner command path.

Add packages/chat/src/reminders/commands/edit.ts and register edit and
edit_selection in commands/registry.ts and commands/types.ts. Add
packages/chat/src/reminders/edit-agreement.ts to bind ambiguity to the latest
completed owner turn, following delete-agreement.ts. Store bounded candidate
IDs, versions and validated proposed terms in code-authored reminder origin
metadata in packages/shared/src/chat-api.ts, rather than another proposal table.
Ask with current text and local timing. Accept only the owner's typed numbered
choice or uniquely matching name; yes alone, model/tool output, attachments,
other owners, unrelated intervening turns and stale versions cannot select.
Recheck the candidate and terms before applying. Keep the proposal inspectable
after reload; superseded proposals cannot apply. Add edited/edit_requested
origin events and the bounded proposal contract; do not change delivery events.

Every visible confirmation, clarification and failure comes from code and
stored records. Field descriptions, a prompt contract with a worked example,
boundary validation and a code-checked before/after field diff guard extracted
values. Direct reminder edits do not add a second approval; typed selection
resolves identity only. Proposed model guidance stays below 150 words.

## Task 1 - storage, validation and delivery safety

Add packages/chat/src/reminders/edit.ts with:
editReminderById(scopedDb: DataContextDb, boss: Pick<PgBoss, "send">,
actorUserId: string, id: string, expectedVersion: number,
terms: ValidatedReminderEdit): Promise<ReminderEditResult>.
Use lockReminderControl. Verify ownership, expected version and queued/paused
state. Derive a full before/after record; retain fields omitted from the edit.
Use existing strict wall-clock conversion, saved timezone and deadline limits.
Reject a moved time that makes a retained deadline invalid; never silently
clear it. Text-only/deadline-only edits preserve due time. A paused edit stays
paused. Changes increment version exactly once and enqueue only queued records
inside the same transaction. A enqueue/save failure rolls back the edit and
its confirmation. No-op edits return the current record without another job.

Add packages/chat/sql/0317_chat_reminder_edits.sql. Replace only the existing
update trigger and add runtime column grants for editable terms. Permit terms
edits only while state remains queued/paused, with version OLD.version + 1.
Validate relative/local-clock consistency, future times when timing changes,
timezone round trips and deadlines. Identity, delivery/context/history fields
remain immutable during edits. Preserve pause/resume, cancel, delivery, expiry,
failure and context-acknowledgement rules from migration 0313. No new tables.
Never edit an applied migration. Existing RLS remains owner-only.

Tests: tests/integration/chat-reminder-edits.test.ts and relevant existing
delivery/permissions/control suites. Prove old queued versions post nothing,
new versions post revised text once, edits while a worker is waiting on the
row lock are observed, and delivery winning the lock returns an honest
already-sent refusal. Once delivery holds the lock the edit cannot land until
it finishes; do not claim already persisted messages can be recalled.
Prove owner/admin negatives, version conflicts, paused edits, atomic queue
failure, deadline expiry/removal, identity immutability and no duplicate jobs.
Observe authority and stale-version tests fail with their guards removed.

## Task 2 - ordinary chat and app map

Implement the above interpretation and command contracts; add code-written
wording in reminders/wording.ts using existing local-time formatting. Include
unit cases in tests/unit/chat-reminder-edits.test.ts and extend command/turn
tests for production wiring, ambiguity, refusal, cancellation and bad model
output. Exercise both successful direct edits and typed target selection.
Extend tests/integration/chat-reminders-cancel-turn.test.ts for real completed
turn atomicity where appropriate. Update reminders/features.ts (owning
manifest declarations) and any existing cancel-and-recreate remediation that
editing supersedes. No new Settings controls or CSS.

Kill gate: after tasks 1 and 2, coordinator decides whether to continue if
the real configured model cannot interpret ordinary edits reliably, or tests
show the existing locked delivery cannot satisfy stale-work suppression.
Escalate evidence; do not patch around the result-posting path.

## Task 3 - verification and live proof

Add tests/uat/specs/3135-reminder-edits-real.uat.spec.ts and blocking rows in
.claude/skills/coordinate/uat-trigger-map.tsv for the edit files, migration,
pre-model turn and persistence wiring. Use the disposable install recipe in
~/.config/moss-proof/README.md, a claimed port and JARVIS_IMAGE_TAG=uat-sched-3135.
Use the sanctioned real-chat Codex login path and its cheapest economy model
for proof, per the coordinator's later ruling. Credentials enter the disposable
install over stdin and are removed at teardown; never copy host Claude login.
Through the real UI, create a near-future queued reminder, change its text
and move its time in chat, inspect Settings and reload, then prove no original
text at the old time and exactly one revised message at the new time. Exercise
ambiguous selection and unsupported edits. Record assertions across desktop
and phone in light mode. No
network response interception and no screenshots. Post bounded proof on PR.

Verification commands (all expected exit 0; never pipe them):

- pnpm exec vitest run tests/unit/chat-reminder-edits.test.ts
- pnpm format:check
- pnpm lint
- pnpm typecheck
- pnpm check:file-size
- scripts/run-gate.sh start (full foundation, isolated database)
- scripts/run-gate.sh wait --follow (background; terminal result is verdict)
- Real UAT invocation from the disposable recipe, with the new spec selected.

Before pushing, fetch/rebase origin/integration/scheduled-proactive and run
the required fast checks. Commit only explicit paths. Push and open the PR
against integration/scheduled-proactive with Part of #3135 and Release note
Category: N/A. Read CI, post live proof or report code-complete, unverified.
Stop servers by PID, remove disposable resources and scratch files, release
the port, leave the worktree clean and send the coordinator the PR number.
Do not modify the board, milestones, docs/coordination or merge anything.

## Rulings ledger

- Issue #3135 comment: model-filled reminder terms save directly; external
  writes still require typed agreement. This supersedes the old no-model-save
  comment in live/pre-model-turn.ts:1 for this edit path only.
- Current delivery is already serialized through the row lock; reuse it
  rather than add another worker or change result posting (deliver.ts:87).
- Rejected alternative: a deterministic-only edit grammar is cheaper and
  predictable, but does not implement the accepted ordinary-chat model-filled
  terms. Keep recognizers for routing and validators for authority instead.
- No unresolved product fork. Coordinator owns plan approval and kill gate.

- Coordinator approval: interpret only explicit edit wording when queued/paused
  reminders exist; everyday sentence negatives must reach Moss unchanged.
- Existing structured parser already unwraps fenced JSON. Test the actual edit
  schema through that parser, rather than adding another unwrap implementation.
- Live proof allows one prompt tuning at most; if the cheapest configured model
  still misreads an ordinary edit, stop and send evidence to the coordinator.
- Coordinator note: edits call the existing shared enqueueReminderDelivery seam,
  not sendJob directly. The second merging lane wires extension-aware routing
  for scheduled source reads from #3151.
- First Codex economy proof selected gpt-5.6-luna and refused the ordinary edit
  before launching a model. The structured adapter received the ACP chat factory,
  which requires a conversation ID. A red regression reproduced that exact
  refusal. Explicit structured launches now use the existing one-shot RPC factory
  on the same connection. All 176 targeted tests pass; live rerun is pending.
- No prompt tuning used. Full final foundation gate and live proof remain required.
