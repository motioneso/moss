# Briefings package

## 0.1.0

- Briefings starts as a built-in package. It keeps the same tables and saved data as before.
- Briefing definitions and past runs work through the same routes as before. Definitions can be shared. Runs stay private to their owner.
- Saving a definition sets or removes its scheduled run in the owner's time zone.
- Writing a briefing, the run job, outside sources and the Briefings screens are not part of this package yet.
- A morning run writes its text through the configured model with signals, suggested-task rows and an email catch-up, and keeps the plain digest when no model answers. Mail and calendar text cannot instruct the model.
- An evening run writes the end-of-day review through the configured model. Tasks are sorted into done today, slipped today and carried forward. Tomorrow's calendar and today's mail are included, and a plain list with the same headings is kept when no model answers.
- A succeeded run asks Calendar to reserve day plan blocks when the person's planning switch is on, and a calendar left out of briefings is not read. Briefings and Calendar now work together through Calendar's public API only.
- Morning and evening runs read the saved day plan and name overnight changes for review.
