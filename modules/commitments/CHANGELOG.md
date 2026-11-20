# Commitments package

## 0.1.2

- Offer the Commitments chat tools with checked inputs and saved-suggestion approval cards.

## 0.1.1

- Email judgement uses the same bounded model-call window as the other model-backed package screens.

- Review saved suggestions on Today: accept, reject, or snooze until tomorrow, next week or a chosen date. Nothing is shown when there is nothing to review.
- The package includes extraction and email judgement jobs, review tools, the heartbeat source, and a reusable approval card rendered from saved records.

## 0.1.0

- Commitments starts as a built-in package. It keeps the same five tables and saved data as before.
- Listing suggestions, filtering them by status, opening one with its evidence, changing its status and marking it as not owed work through the same routes as before.
- Marking a suggestion as resolved is refused as unavailable, as before, because no checker is connected.
- A missing suggestion answers "not found" and a malformed id answers "bad request", where the old code answered with a server error.
- Finding suggestions in email and chat, chat tools, the heartbeat and the screen are not part of this package yet.
