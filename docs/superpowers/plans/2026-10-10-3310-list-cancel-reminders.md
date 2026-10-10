# #3310 List and cancel relative reminders

Parent #3194, reslice in `2026-10-09-chat-repairs-and-relative-reminder-reslices.md`. Builds on
#3309 (save and deliver one relative reminder). Sibling #3311 (context admission) runs in parallel.

## Outcome

In Main chat, the owner can list their relative reminders and cancel one. Cancel answers honestly
whether it landed before or after delivery.

## Rules carried from #3194

- List and cancel act only on the exact server-held current user request. The model never calls
  them, no tool or REST route exposes them, and source content never triggers them.
- Main chat only. Private, side and module turns get a code-written refusal.
- Replies are code-written and stored with a typed reminder origin, like the save reply.
- Stop rolls the whole turn back, including any cancel.

## Data (migration `0308_chat_reminder_cancel.sql`)

| Change            | Detail                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `state`           | Adds `cancelled`. Only `queued -> cancelled`; `delivered_at` and `late` stay NULL.                              |
| `context_state`   | Adds `dismissed`. Only `delivered/pending -> delivered/dismissed`.                                              |
| Update trigger    | Replaced. Allows the two cancel moves plus the existing delivery moves. Everything else stays immutable.        |
| App UPDATE policy | Owner of row and thread. `WITH CHECK` admits only `cancelled`, or `delivered` with `dismissed`.                 |
| Grants            | `UPDATE` on `app.chat_reminders` to `jarvis_app_runtime`. Worker policy unchanged, so the worker cannot cancel. |

The open-count function already counts only `queued` and `delivered/pending`, so both cancel moves
free a slot with no change to it. #3311 will add its own acknowledged context value and also replace
the update trigger; whichever lands second merges both transition sets.

## Linearization

Cancel and delivery both take `SELECT ... FOR UPDATE` on the reminder row.

- Cancel first: the row becomes `cancelled`. The worker's lock query no longer matches (its policy
  requires `queued`), it reads the state, returns a new `cancelled` outcome and posts nothing.
- Delivery first, including a worker paused just before posting: cancel waits on the lock, then
  sees `delivered`, answers "already delivered" and dismisses the pending context so the slot frees.
- Worker rolls back after pausing: cancel then succeeds, and the retried job returns `cancelled`.

## Recognizer (`reminders/commands.ts`)

- List: "list/show my reminders", "what are my reminders", "do I have any reminders", "what
  reminders do I have", with the same filler stripping as the save recognizer.
- Cancel: "cancel/delete/remove [my/the/that] reminder [to/about/for] X", "cancel the X reminder",
  "cancel my reminders" with no target.

## Cancel target choice (inside the turn transaction, under the row lock)

1. Exact normalized text match among the owner's reminders, else containment.
2. One open match: cancel it. Several open matches: refuse and name them.
3. No open match but a finished one: say it was already delivered, already cancelled or failed.
4. No target text: act only when exactly one reminder is open; otherwise ask which one.

## List reply

All open reminders with time remaining, then up to 10 recent finished ones with their state.

## Code

- `reminders/repository.ts`: list, lock-for-cancel, cancel, dismiss.
- `reminders/cancel.ts`: target choice and decisions; `turn.ts` gains `list` and `cancel` plans.
- `reminders/deliver.ts`: `cancelled` outcome, including the final-attempt path.
- `reminders/wording.ts`: list, cancel, already-delivered and Main-only wording.
- `shared/chat-api.ts`: origin events `listed`, `cancelled`, `cancel_refused`.
- `live/pre-model-turn.ts`: one composition hook so the new recognizer runs beside the save one.
- `manifest.ts`: migration entry and app-map features for list and cancel.
- Schema catalog test: add `0308`.

## Tests

- Integration: cancel before due, cancel after delivery, both orders, paused worker that commits,
  paused worker that rolls back, cancelled job posts nothing, earlier messages kept, slot freed.
- Negatives, each observed failing with its enforcement removed then restored: another owner
  cannot list or cancel, worker cannot cancel, app cannot forge `delivered` or reopen a reminder,
  stopped turn leaves the reminder open, non-Main turn cannot cancel, no route or tool exists.
- Unit: recognizer, target choice, wording.

## Live proof

Isolated install on a dev port with a real CLI-signed-in cheapest model. Cancel before due and
nothing arrives. Cancel after delivery and Moss says it was already delivered. List shows both.
