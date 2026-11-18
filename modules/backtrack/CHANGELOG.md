# Backtrack package

## 0.1.1

- Settings now has a Backtrack screen. It shows the recording switch that pauses every Mac, how many days and how much text are kept, and when a Mac last sent text.
- The screen deletes the last hour, today, one chosen day or everything, and asks first every time.
- It shows its own messages while loading, when loading fails, when no Mac is linked, and when an admin has not turned storage on.

## 0.1.0

- Backtrack starts as a built-in package that cannot be turned off. It keeps the same tables and saved data as before.
- Status, the pause switch and deleting history (everything, or a range of up to 31 days) work through the same routes as before. Everything stays private to each account.
- A paired Mac can send screen text. Nothing is stored while recording is paused, and a Mac whose clock is more than an hour off is refused.
- Screen text is stored for 37 days. An hourly job removes older text.
- Your account export includes your Backtrack history.
- Stored screen text is added to Memory's search, and removed from it when the history is deleted or expires. Memory must be installed.
