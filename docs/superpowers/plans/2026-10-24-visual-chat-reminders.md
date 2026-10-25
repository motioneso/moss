# Read-only reminder visual summaries

Task [#3667](https://github.com/motioneso/moss/issues/3667), part of [#3583](https://github.com/motioneso/moss/issues/3583).
Implements the approved [visual replies spec](../specs/2026-10-23-visual-chat-replies.md),
[staged plan](2026-10-23-visual-chat-replies.md) and [handoff](../handoffs/2026-10-24-visual-chat-reminders.md).
Template is the merged Tasks slice ([plan](2026-10-24-visual-chat-tasks.md), PR #3661).
Work stays in `~/Jarv1s/.claude/worktrees/visual-chat-reminders`.

## Verified seams

| Assumed capability    | Source evidence                                                                        | Decision                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reminder storage      | `packages/chat/sql/0306_chat_relative_reminders.sql`, later `0308`-`0320`              | Table `app.chat_reminders`, owner-only RLS. Read it with plain SELECT through the branded DataContextDb.                                                                                                                             |
| Existing read         | `packages/chat/src/reminders/repository.ts` `listOwned`                                | Unbounded, newest first, lacks timezone, repeat, destination and delivery fields. Leave unchanged; add a separate summary reader.                                                                                                    |
| Lifecycle vs context  | `ChatReminderState`, `ChatReminderContextState` in `packages/db/src/types.ts`          | `state` is lifecycle (queued, paused, delivered, failed, cancelled, expired). `context_state` (pending, dismissed, acknowledged) only says whether chat context still shows it. Report both and never call dismissal a cancellation. |
| Schedule terms        | `0311`, `0319`, `0320`                                                                 | Report `due_at`, `deadline_at`, `timing`, `local_due`, `time_zone`, `repeat_kind`, `repeat_seconds`, `destination_title` (null means Main chat), `delivered_at`, `late`, `expired_at`.                                               |
| Repeats               | `packages/chat/src/reminders/repeating.ts`                                             | Advancement happens at delivery. The summary shows the persisted next occurrence only and never calls `nextReminderOccurrence`.                                                                                                      |
| Actor zone            | `packages/shared/src/time.ts` `resolveTimeZone`, `localDay`                            | Chat must not import Tasks internals. Read the saved `locale` preference in chat with the same Pacific fallback and validation.                                                                                                      |
| Tool registration     | `packages/chat/src/manifest.ts` `assistantTools`, `packages/tasks/src/summary/tool.ts` | Add `chat.remindersSummary`, permission `chat.view`, risk read, content outside.                                                                                                                                                     |
| Browser-safe template | `packages/tasks/package.json` exports, `packages/settings-ui/src/scanner.ts:169`       | Chat package gains `./visual` and `./web/visual` exports so the scanner finds the template and lazy card. Core chat gets no reminder-specific branches.                                                                              |
| Card                  | `packages/tasks/src/summary/card.tsx`, `docs/design-system.md`                         | Compose Card, SectionHead, Badge, Note. Static rows, no buttons, links, checkboxes or controls.                                                                                                                                      |
| Installed acceptance  | `tests/uat/specs/3659-visual-chat-tasks.uat.spec.ts`                                   | Reuse that harness on the moss-proof copy (port 5181).                                                                                                                                                                               |

## Scope and contracts

New files under `packages/chat/src/reminders/summary/`: `types`, `repository`, `contract`, `tool`,
`output-schema`, `card.tsx`, `card.css`. No migration. No change to existing reminder code paths
(PRs 3535 and 3536 behavior is untouched).

Tool `chat.remindersSummary({scope?})`. Scopes: `upcoming` (queued and paused, default),
`delivered`, `ended` (cancelled, expired, failed), `all`. At most twelve rows, one lookahead row
read for truncation, ordered by `due_at` then `id`. If complete source text exceeds the shared
fallback budget, keep a shorter ordered prefix, mark partial, and never clip reminder text.
An empty result describes only the chosen scope, not the whole account.

Per row: id, reminder text, lifecycle state, context state, timing kind, due instant, deadline
instant or null, actor-local due day, repeat terms or null, destination title or Main chat,
delivered instant and lateness when delivered, created instant. The snapshot carries scope,
actor time zone, local date, source time, truncation and explicit coverage.

Coverage text states that future repeat occurrences are not generated, that dismissing a
reminder from chat context is not cancelling or delivering it, that the result is bounded,
and that nothing was changed.

SELECT only. No row locks, no `FOR UPDATE`, no writes, no job enqueue, no delivery, no
reconciliation, no run-table reads, no notifications. No controls, subscriptions or actions.

The module owns identities, values, statuses, timestamps, coverage and fallback. The model
chooses whether and how to present approved facts and writes concise grounded interpretation.
Tool guidance stays under 150 words. Snapshots validate exact keys, enums, bounds, unique ids,
local-day derivations, state/field consistency (delivered rows have `delivered_at`, others do
not) and coverage text before accepted persistence. History is immutable and performs no read.

Rejected: reusing `listOwned` (unbounded, wrong fields); reading the run table (adds delivery
detail the slice does not need); recomputing next occurrences (would imply reconciliation).

## Tests and acceptance

1. Contract unit tests: each state and context state, relative vs local-clock, deadline, each
   repeat kind, destination vs Main, UTC vs local-day boundaries, DST days, empty, truncated,
   malformed and forged snapshots, wrong coverage, readable fallback. Each guard gets a negative
   control that fails when the guard is removed.
2. Integration through the real actor context: owner, other user and admin (denied), scope
   filters and lookahead, byte-identical rows and unchanged version before and after, no jobs
   enqueued. Remove the access guard in an isolated transaction and observe the assertion fail.
3. Freeze a clean candidate and twenty ordinary prompts before installed acceptance. Real
   sign-in on moss-proof (port 5181, LAN address), reminders created through the real chat,
   configured economy model. At least 19/20 first-attempt intended visuals and useful text in
   all twenty. Manually assess every answer. Retain every failed attempt. No intercepted or
   faked network data.
4. Four prose controls, one novel composition, Weather/Sports/Tasks preservation, immutable
   reload, 404px drawer, 390px phone, themes. Measure latency and output; no unmeasured cost claims.

Kill gate: a real failure of runtime, coverage or reliability gets a measured recommendation on
#3583. The renderer, prompts and 19/20 threshold are not relaxed and a retry is never relabeled
first attempt.

## Delivery

Commit and push this plan before product code. Update the app map in the owning chat manifest
(`features` entry with error and remediation) in the same PR. Add script `test:integration:3667`.
Fresh independent Standards and Spec reviews of the exact head; fix findings and rerun affected
checks. Unpiped: scoped ESLint and Prettier, `pnpm exec tsc --noEmit`, package typechecks, Vitest,
design-token audits. Full gate only through `verify-gate`. Fill the PR Release note in plain
English. `gh pr merge --squash --auto` once required checks pass; never `--admin`.
