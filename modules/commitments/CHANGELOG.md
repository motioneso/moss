# Commitments package

## 0.1.0

- Commitments starts as a built-in package. It keeps the same five tables and saved data as before.
- Listing suggestions, filtering them by status, opening one with its evidence, changing its status and marking it as not owed work through the same routes as before.
- Marking a suggestion as resolved is refused as unavailable, as before, because no checker is connected.
- A missing suggestion answers "not found" and a malformed id answers "bad request", where the old code answered with a server error.
- Finding suggestions in email and chat, chat tools, the heartbeat and the screen are not part of this package yet.
