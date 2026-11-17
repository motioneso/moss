# Wellness package

## 0.1.0

- Insights work through the same route as before: up to five lines from your last 30 days, worked out in code, nothing sent to a model.
- Two chat tools work as before: your 20 newest check-ins, and seven-day medication counts. With assistant access off, both answer only that access is off.
- Therapy notes work through the same routes as before: list, save and delete. Each note can point to one of your own check-ins or one of the six core feelings.
- Export works through the same request, status and download steps. It can now include check-ins and therapy notes, and only the chosen categories appear in the page.
- Medications and insights cannot be chosen for an export yet. A finished export is kept for 24 hours and then reads as expired.
- The download comes back as the page inside a small JSON envelope with its file name, because package routes cannot send a raw file.
- The Wellness parts of the whole-account export and delete are available to the rest of Moss.
- Wellness starts as a built-in package. It keeps the same four tables and saved data as before.
- Mood check-ins work through the same routes as before: save, read history in pages and change.
- The assistant-access choice is read and saved through the same preference as before.
- Medications work through the same routes as before: list, add, change, the day's doses, dose records and thirty-day counts. All eight schedule kinds keep the old calendar rules.
- Other parts of Moss can read a seven-day count of doses (counts only, never a medicine name) when the person allows assistant access.
- A medication reminder queue is declared, with no sender yet, as before.
- A date or time the old server crashed on (500) now gets a plain 400: an unreal date for the day's doses, an unreadable dose time, a bad clock time in a schedule.
- Therapy notes work through the same routes as before: list, save (optionally linked to a check-in) and delete.
- Exports work through the same routes as before: request a date range and categories, check progress and download within 24 hours. Medication and insight export are not available yet.
- The package now carries the Wellness parts of the account export and delete.
- Insights, chat tools, reminders and the screens are not part of this package yet.
- Check-ins no longer write the energy-trend note the old server wrote to chat memory.
