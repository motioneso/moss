# Wellness package

## 0.1.0

- Therapy notes work through the same routes as before: list, save and delete. Each note can point to one of your own check-ins or one of the six core feelings.
- Export works through the same request, status and download steps. It can now include check-ins and therapy notes, and only the chosen categories appear in the page.
- Medications and insights cannot be chosen for an export yet. A finished export is kept for 24 hours and then reads as expired.
- The download comes back as the page inside a small JSON envelope with its file name, because package routes cannot send a raw file.
- The Wellness parts of the whole-account export and delete are available to the rest of Moss.
- Wellness starts as a built-in package. It keeps the same four tables and saved data as before.
- Mood check-ins work through the same routes as before: save, read history in pages and change.
- The assistant-access choice is read and saved through the same preference as before.
- Medications, insights, chat tools, reminders and the screens are not part of this package yet.
- Check-ins no longer write the energy-trend note the old server wrote to chat memory.
