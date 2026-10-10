# #3309 Relative reminder: save once, deliver once to Main history

Parent #3194. Requirements: `2026-10-09-chat-repairs-and-relative-reminder-reslices.md`
(lines 137-182 and the "#3194 reslice" section). Branch base: `integration/scheduled-proactive`.

## Scope

- In: recognize one explicit relative reminder in the raw Main request, save it, deliver it once
  to owner Main history (including late recovery), app map truth.
- Out: list/cancel (#3310), next-turn admission (#3311), live stream arrival (#3195).

## Units

| Unit                    | Files                                                                 | Notes                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recognizer              | `packages/chat/src/reminders/recognizer.ts`                           | Pure. Integer seconds/minutes/hours/days, total 1-2,592,000 s, text 1-500 chars. Returns `none`, `unsupported` (reminder-like but out of bounds or clock/recurring/ambiguous) or `request`.                                          |
| Table + policies        | `packages/chat/sql/0300_chat_relative_reminders.sql`                  | Owner-only RLS; per-owner advisory lock and 20 open cap in a trigger; unique source message id and reserved message id; worker insert grant on `chat_messages` limited by policy to the reserved assistant row of a queued reminder. |
| Repository              | `packages/chat/src/reminders/repository.ts`                           | Create (inside the handled-turn transaction), lock-for-delivery, mark delivered.                                                                                                                                                     |
| Public assistant insert | `packages/chat/src/repository.ts`                                     | Narrow `recordReservedAssistantMessage` (assistant role only, explicit id, owner Main thread).                                                                                                                                       |
| Pre-model step          | `packages/chat/src/live/pre-model-turn.ts`                            | Wraps the classifier gate call in the session manager (no line growth there). Runs only for nonprivate Main drawer turns with no module control, before any model, retrieval or tool.                                                |
| Atomic save             | `packages/chat/src/live/persistence.ts`                               | Optional in-transaction hook on the handled-turn write so turn rows, reminder row and scoped job commit together.                                                                                                                    |
| Queue + worker          | `packages/chat/src/jobs.ts`, `packages/chat/src/reminders/deliver.ts` | `chat.deliver-reminder`; payload `{actorUserId, resourceId, version}`; singleton `${id}:${version}`; `startAfter` due time; job inserted with `scopedJobDatabase`.                                                                   |
| App map                 | `packages/chat/src/manifest.ts`                                       | Feature `chat.relative_reminders`.                                                                                                                                                                                                   |
| Origin                  | `packages/shared/src/chat-api.ts`                                     | Turn origin `reminder` for the handled confirmation turn.                                                                                                                                                                            |

## Authority

- Timing and text come only from the raw request captured before any model output.
- No REST route and no tool can create a reminder, so the generic app-call tool and the
  classifier path cannot reach the create operation. Tests assert both.
- Private, side, module-controlled and stopped turns never save.

## Delivery

- Worker transaction: `SELECT ... FOR UPDATE` on the exact row, recheck owner, `queued` state,
  version, due time and that the reserved thread is still the owner's Main. Insert the reserved
  assistant message, set `delivered`, `context_state = 'pending'`, `late`.
- Replay or a second worker finds `delivered` and does nothing. Unique reserved id is the
  backstop.
- Late: delivered more than 60 seconds after due (polling is 2 seconds) uses honest late
  wording. Quiet hours are not consulted.
- Delivered reminders stay `pending` context and count toward the cap until #3311.

## Negative tests (each observed failing with its enforcement removed)

- Row security: another owner cannot read or write a reminder.
- Worker grant: worker cannot insert a user row, a non-reserved id, or into another owner's thread.
- Capacity: 21st open reminder is refused, also under concurrent inserts.
- Intent: private, side, module, stopped, suggested and unsupported requests do not save.
- Duplicate: repeated create for the same source message, concurrent and replayed workers
  produce exactly one message.

## Proof

Isolated install on port 5182 with a real model: save, close/reopen, exactly one Main message;
worker stopped across due time then restarted, one late message; one falls due during a
streaming Main reply, both saved.
