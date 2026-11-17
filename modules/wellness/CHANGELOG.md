# Wellness package

## 0.1.0

- Wellness starts as a built-in package. It keeps the same four tables and saved data as before.
- Mood check-ins work through the same routes as before: save, read history in pages and change.
- The assistant-access choice is read and saved through the same preference as before.
- Medications work through the same routes as before: list, add, change, the day's doses, dose records and thirty-day counts. All eight schedule kinds keep the old calendar rules.
- Other parts of Moss can read a seven-day count of doses (counts only, never a medicine name) when the person allows assistant access.
- A medication reminder queue is declared, with no sender yet, as before.
- A date or time the old server crashed on (500) now gets a plain 400: an unreal date for the day's doses, an unreadable dose time, a bad clock time in a schedule.
- Therapy notes, insights, export, chat tools and the screens are not part of this package yet.
- Check-ins no longer write the energy-trend note the old server wrote to chat memory.
