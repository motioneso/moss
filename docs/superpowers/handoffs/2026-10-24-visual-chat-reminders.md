# Visual chat: read-only reminder summaries (#3667)

Branch `feat/visual-chat-reminders-3667`, worktree `~/Jarv1s/.claude/worktrees/visual-chat-reminders`.
Part of #3583. Template: merged PR #3661 (Tasks) and `2026-10-24-visual-chat-tasks.md`.
Stopped 2026-10-24 for a machine restart. No product code written, no PR, nothing running.

## Done

- Dependencies installed in the worktree.
- Read issue 3667, the Tasks handoff and plan, and the Tasks summary files
  (`packages/tasks/src/summary/*`, manifest and package export wiring).
- Located the reminder source (see findings).

## Not started

- Implementation plan (must be committed before product code).
- Product code, app map, tests, reviews, local gate, live acceptance on moss-proof, PR.

## Findings

- Reminders live in the chat module, not a separate package: table `app.chat_reminders`
  (`packages/chat/sql/0306`, `0308`, `0309`, `0311`, `0313`, `0317`, `0319`, `0320`),
  repository `packages/chat/src/reminders/repository.ts` (`listOwned` is SELECT-only, newest first,
  unbounded, and has no repeat, timezone, destination or delivery fields).
- Columns to report: `reminder_text`, `state` (queued, paused, delivered, failed, cancelled, expired),
  `context_state` (pending, dismissed, acknowledged), `timing` (relative, local_clock), `due_at`,
  `deadline_at`, `local_due`, `time_zone`, `repeat_kind`, `repeat_seconds`, `destination_title`
  (null means Main chat), `delivered_at`, `late`, `expired_at`, `created_at`.
- `context_state = dismissed` only hides the reminder from chat context. `state` is the real
  lifecycle. The summary must keep these two separate.
- Chat has no reminder list tool and no visual template yet. Chat `package.json` has no
  `./visual` or `./web/visual` export (the settings scanner needs both to discover a template).
- `readActorTimezone` lives in `packages/tasks/src/drift.ts`. Chat must not import Tasks internals,
  so read the `locale` preference directly or use `resolveTimeZone` from `@moss/shared`.
- Tasks plan scopes and 12-row limit plus one lookahead row are the model to copy.

## Proposed design (not yet approved or committed)

- Tool `chat.remindersSummary({scope?})`, permission `chat.view`, risk read. Scopes: upcoming
  (queued and paused, default), delivered, ended (cancelled, expired, failed), all.
- New files `packages/chat/src/reminders/summary/{types,repository,contract,tool,card}.ts[x]` plus
  card CSS, output schema, chat manifest wiring (`assistantTools`, `visualTemplates`, a feature entry
  with error and remediation), chat package exports.
- SELECT only: no lock, no delivery or run-table reads, no advancing repeats. Report persisted
  `due_at` as stored. Coverage text must say future occurrences are not generated and that a
  bounded result is not a whole-account total.
- Update the app map in the same PR. Add a `test:integration:3667` script. Fill in the PR Release note.

## Next step

1. Write `docs/superpowers/plans/2026-10-24-visual-chat-reminders.md` from the Tasks plan, commit and
   push it before any product code.
2. Build, then independent Standards and Spec review of the exact head, `verify-gate` full gate,
   CI, 20-prompt live run on moss-proof (port 5181), then `gh pr merge --squash --auto`.
