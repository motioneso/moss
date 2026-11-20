# Briefings package

## 0.1.0

- Briefings starts as a built-in package. It keeps the same tables and saved data as before.
- Briefing definitions and past runs work through the same routes as before. Definitions can be shared. Runs stay private to their owner.
- Saving a definition sets or removes its scheduled run in the owner's time zone.
- Writing a briefing, the run job, outside sources are not part of this package yet.
- Briefings now serves its own screens. Briefing settings set the morning and evening times and the morning sources. The briefing reader shows the morning or evening report, suggested-task rows, the email catch-up, news and sports, and what informed the briefing. Accepting or dismissing rows and catch-up emails stays on Today.
- A morning run writes its text through the configured model with signals, suggested-task rows and an email catch-up, and keeps the plain digest when no model answers. Mail and calendar text cannot instruct the model.
- An evening run writes the end-of-day review through the configured model. Tasks are sorted into done today, slipped today and carried forward. Tomorrow's calendar and today's mail are included, and a plain list with the same headings is kept when no model answers.
- A succeeded run asks Calendar to reserve day plan blocks when the person's planning switch is on, and a calendar left out of briefings is not read. Briefings and Calendar now work together through Calendar's public API only.
- Morning and evening runs read the saved day plan and name overnight changes for review.
- Chat can re-run your own briefing after you approve it, and can check whether a run is ready, still going or failed. It never touches anyone else's briefing, and a second re-run while one is going is refused. The briefing text it reads back is treated as outside text.
- The briefing shows the top news stories from News when the news tool is selected. With no stored page the briefing shows a news gap.
- The briefing shows today's facts for followed teams and leagues from Sports, in the person's time zone, when the sports tool is selected. If Sports cannot answer, the briefing shows a sports gap.
- Briefings settings now show Include email signal and Include calendar signal. Each one changes the same switch the Email or Calendar settings screen shows, only for you, and is hidden when that module is not installed. Briefings now asks to call Email as well.
- Today shows a Needs you section from Briefings. Each follow-up from your latest morning briefing can be accepted or dismissed there, and the row then says Accepted or Dismissed, read from the task itself. Another account's task is never touched. This needs Tasks 0.1.5; with an older Tasks the rows show without buttons.
