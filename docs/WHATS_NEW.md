# What's New in Moss

## Edge channel — 2026-08-19

Edge builds include the stable history below plus the user-facing changes already available in
the current edge image. This section is intentionally build-bundled so it never advertises a
feature that is not present in the image you are running.

### Added

- **Food tracking (Phase 1).** Log meals, get an estimated nutrition breakdown, and review what
  you've eaten so far today. [PR #1716](https://github.com/motioneso/moss/pull/1716)
- **More reliable calendar changes.** Creating, rescheduling, and deleting calendar events now
  goes through a more reliable lookup step, so the assistant confirms it has the right event
  before changing it. [PR #1703](https://github.com/motioneso/moss/pull/1703)
- **Recently Released.** Settings now includes a read-only release history so you can see what
  Moss has added, fixed, and changed. [PR #1630](https://github.com/motioneso/moss/pull/1630)
- **Recall relevant notes before answering.** Chat can use relevant notes as context before it
  answers, making note-backed conversations more useful. [PR #1619](https://github.com/motioneso/moss/pull/1619)
- **Threaded chat routing.** Chat sends now preserve the active thread surface so replies stay
  attached to the conversation you started. [PR #1574](https://github.com/motioneso/moss/pull/1574)
- **Vault ingestion.** Notes and other approved vault content can be ingested through the new
  allowlisted ingestion path. [PR #1606](https://github.com/motioneso/moss/pull/1606)
- **Approval-card summaries.** Action cards now prefer a module's user-facing action label when
  one is available. [PR #1492](https://github.com/motioneso/moss/pull/1492)

### Fixed

- **All-day events no longer block scheduling.** Holidays, reminders, and other all-day calendar
  entries no longer make the assistant think a day is fully booked. [PR #1717](https://github.com/motioneso/moss/pull/1717)
- **Clearer, more accurate settings descriptions.** The assistant now gives better answers to
  "what can I do here" and explains errors more accurately across email, notes, memory, news,
  goals, tasks, wellness, weather, web research, AI, briefings, calendar, chat, commitments, and
  connectors settings. [PR #1726](https://github.com/motioneso/moss/pull/1726) · [PR #1727](https://github.com/motioneso/moss/pull/1727) · [PR #1728](https://github.com/motioneso/moss/pull/1728)
- **Data exports resume correctly.** Navigating away from Account & preferences and back no longer
  loses track of an in-progress export or starts a duplicate one. [PR #1653](https://github.com/motioneso/moss/pull/1653)
- **UI polish.** Clearer sidebar contrast, friendlier empty-state messages, improved spacing, and
  better hover feedback. [PR #1688](https://github.com/motioneso/moss/pull/1688)
- **Stale module backups no longer get stuck.** Old backup copies of a module are cleaned up
  properly instead of getting wedged or showing up as if they were real installed modules.
  [PR #1657](https://github.com/motioneso/moss/pull/1657)
- **Module version pins are honored exactly.** Updating a module now respects an exact version
  pin even when a different version is already on disk. [PR #1656](https://github.com/motioneso/moss/pull/1656)
- **Additional security hardening.** Further tightening of outbound network requests, external
  module input handling, and chat action validation. [PR #1601](https://github.com/motioneso/moss/pull/1601) · [PR #1613](https://github.com/motioneso/moss/pull/1613) · [PR #1663](https://github.com/motioneso/moss/pull/1663) · [PR #1690](https://github.com/motioneso/moss/pull/1690) · [PR #1691](https://github.com/motioneso/moss/pull/1691)
- **Safer external-module validation.** Patterned input validation now stays bounded and keeps
  the host responsive even for hostile input. [PR #1608](https://github.com/motioneso/moss/pull/1608)
- **Weather location overrides.** A manually selected weather location now remains authoritative
  instead of being replaced by an automatic lookup. [PR #1535](https://github.com/motioneso/moss/pull/1535)
- **Chat availability and approval recovery.** Chat now waits for the selected model route and
  restores approval cards reliably after the drawer is reopened. [PR #1482](https://github.com/motioneso/moss/pull/1482) · [PR #1494](https://github.com/motioneso/moss/pull/1494)

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
  so it no longer appends data-staleness details most people skip. [PR #595](https://github.com/motioneso/Jarv1s/pull/595) · [#586](https://github.com/motioneso/Jarv1s/issues/586)
- **Briefings list their actual sources.** Briefings settings now names the email accounts,
  calendars, and note folders feeding each briefing instead of showing only a count. [PR #594](https://github.com/motioneso/Jarv1s/pull/594) · [#506](https://github.com/motioneso/Jarv1s/issues/506)
- **Paste a Coolors palette to stage it immediately.** Pasting a Coolors URL or colour list in
  Appearance settings now updates the preview without a separate staging step. [PR #598](https://github.com/motioneso/Jarv1s/pull/598)
