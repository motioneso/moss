# What's New in Moss

## v0.1.16 — 2026-08-05

### Added

- **Guided Job Search onboarding.** Job Search now opens as a guided flow inside Moss, with
  dedicated search screens and an embedded assistant. Reloading restores the profile step you were
  on instead of sending you back to the start. [PR #1204](https://github.com/motioneso/Jarv1s/pull/1204) · [PR #1209](https://github.com/motioneso/Jarv1s/pull/1209) · [PR #1212](https://github.com/motioneso/Jarv1s/pull/1212) · [PR #1214](https://github.com/motioneso/Jarv1s/pull/1214) · [PR #1215](https://github.com/motioneso/Jarv1s/pull/1215)
- **Attach files and screenshots in chat.** You can attach files or paste screenshots directly into
  the chat drawer, keeping supporting material with the conversation instead of describing it
  separately. [PR #1156](https://github.com/motioneso/Jarv1s/pull/1156)
- **Finance reports that understand transfers.** The Finance module now produces spending,
  cash-flow, and net-worth reports and automatically pairs transfers so moving money between
  accounts does not look like income or spending. [PR #1163](https://github.com/motioneso/Jarv1s/pull/1163) · [PR #1173](https://github.com/motioneso/Jarv1s/pull/1173)
- **Weekly delivery reports.** A scheduled weekly report now summarizes what shipped, giving you a
  compact record of recent product changes without manually reviewing individual pull requests.
  [PR #1129](https://github.com/motioneso/Jarv1s/pull/1129)
- **App-grounded help.** Moss can now look up shipped screens, settings, prerequisites, and named
  fixes from the app's build artifact. The generated app map remains the authority for behavior and
  remediation.
- **Your timezone, everywhere (first slice).** Dates and times in chat answers, wellness history,
  and briefings now render in your configured timezone instead of UTC. More display surfaces are
  in progress. [PR #596](https://github.com/motioneso/Jarv1s/pull/596) · [#579](https://github.com/motioneso/Jarv1s/issues/579)
- **Delete calendar events.** Moss can now remove events from your calendar, not just read them.
  Ask it to cancel a meeting, clear a block, or tidy up stale events and it will handle the deletion
  directly. [PR #569](https://github.com/motioneso/Jarv1s/pull/569) · [#557](https://github.com/motioneso/Jarv1s/issues/557)
- **Automatic commitment extraction.** Moss now notices commitments in email, calendar events, and
  notes and surfaces what you have agreed to do or attend. [PR #570](https://github.com/motioneso/Jarv1s/pull/570) · [#537](https://github.com/motioneso/Jarv1s/issues/537)
- **Source-backed answers.** Moss answers now cite the specific messages, meetings, and notes they
  came from so you can verify the reasoning. [PR #571](https://github.com/motioneso/Jarv1s/pull/571) · [#539](https://github.com/motioneso/Jarv1s/issues/539)
- **Data freshness indicator.** The chat footer now shows how current the data behind each answer
  is, making it clear when a manual refresh would help. [PR #572](https://github.com/motioneso/Jarv1s/pull/572) · [#541](https://github.com/motioneso/Jarv1s/issues/541)
- **Automation audit log.** Every action Moss takes on your behalf is now recorded for review and
  export. [PR #573](https://github.com/motioneso/Jarv1s/pull/573) · [#540](https://github.com/motioneso/Jarv1s/issues/540)
- **People knowledge graph.** Moss now links the same person across emails, calendar events, and
  notes and provides tools to query their shared context. [PR #574](https://github.com/motioneso/Jarv1s/pull/574) · [#538](https://github.com/motioneso/Jarv1s/issues/538)

### Fixed

- **More resilient live chat.** Live chat now recovers from stale sessions, and multiline pasted
  messages no longer trigger false delivery failures or attachment-turn errors. [PR #1160](https://github.com/motioneso/Jarv1s/pull/1160) · [PR #1172](https://github.com/motioneso/Jarv1s/pull/1172) · [PR #1175](https://github.com/motioneso/Jarv1s/pull/1175)
- **Mobile menu always reachable.** The user menu no longer scrolls off screen on smaller
  viewports. [PR #591](https://github.com/motioneso/Jarv1s/pull/591) · [#524](https://github.com/motioneso/Jarv1s/issues/524)
- **Wellness notes reach Moss.** Free-text wellness check-in notes are now available when you ask
  about your wellbeing or patterns, and wellness exports work correctly. [PR #582](https://github.com/motioneso/Jarv1s/pull/582) · [#505](https://github.com/motioneso/Jarv1s/issues/505) · [#509](https://github.com/motioneso/Jarv1s/issues/509)
- **Cleaner chat actions.** Approve and reject controls now have correct spacing and labels, and the
  Today view no longer shows an irrelevant medication nudge. [PR #581](https://github.com/motioneso/Jarv1s/pull/581) · [#480](https://github.com/motioneso/Jarv1s/issues/480) · [#512](https://github.com/motioneso/Jarv1s/issues/512)

### Changed

- **Moss knows which screen you are viewing.** Moss can now use the current page and app context
  when answering, so in-app help needs less explanation. [PR #1126](https://github.com/motioneso/Jarv1s/pull/1126)
- **Easier module setup.** Settings now shows credential controls for registry-installed modules,
  making required connections visible where you manage the module. [PR #1178](https://github.com/motioneso/Jarv1s/pull/1178)
- **Cleaner Evening review.** The Sources freshness list has been removed from the Evening review
  so it no longer appends data-staleness details most people skip. [PR #595](https://github.com/motioneso/Jarv1s/pull/595) · [PR #586](https://github.com/motioneso/Jarv1s/pull/586)
- **Briefings list their actual sources.** Briefings settings now names the email accounts,
  calendars, and note folders feeding each briefing instead of showing only a count. [PR #594](https://github.com/motioneso/Jarv1s/pull/594) · [#506](https://github.com/motioneso/Jarv1s/issues/506)
- **Paste a Coolors palette to stage it immediately.** Pasting a Coolors URL or colour list in
  Appearance settings now updates the preview without a separate staging step. [PR #598](https://github.com/motioneso/Jarv1s/pull/598)
