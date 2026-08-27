# What's New in Moss

## 2026-08-21

### Added

- **A more useful Food day view.** See calories and macros at a glance, browse meals by time of day, and expand a meal to see the foods behind its estimate. Meals logged in Chat now appear here without a manual refresh. [PR #1744](https://github.com/motioneso/moss/pull/1744)
- **Food estimates you can control.** Nutrition estimates now run automatically, with a simple switch in Settings and no extra consent question in Chat. [PR #1751](https://github.com/motioneso/moss/pull/1751)
- **Daily targets and richer module settings.** Food can show daily targets, while module settings can include whole-number values as well as on/off switches. [PR #1767](https://github.com/motioneso/moss/pull/1767)
- **Settings for installed modules.** Your installed modules now appear in your personal settings, where you can manage your own sign-ins and jump straight to a module's settings when available. [PR #1764](https://github.com/motioneso/moss/pull/1764) · [PR #1765](https://github.com/motioneso/moss/pull/1765)

### Fixed

- **Food looks at home in Moss.** The Food day view now uses the same cards, totals, and visual building blocks as the rest of the app. [PR #1733](https://github.com/motioneso/moss/pull/1733)
- **No more phantom nutrition estimates.** When AI estimates are turned off, logging a meal no longer says an estimate is on the way. [PR #1771](https://github.com/motioneso/moss/pull/1771)
- **Private chat respects your latest choice.** A stale response can no longer undo the privacy setting you just selected. [PR #1781](https://github.com/motioneso/moss/pull/1781)
- **Chat actions are harder to double-submit.** Approve and reject cards now handle quick repeated clicks safely, and expired actions explain what happened more clearly. [PR #1649](https://github.com/motioneso/moss/pull/1649)
- **Clearer module error messages.** When a module input is rejected, the error now says which action needs attention so the problem is easier to understand. [PR #1645](https://github.com/motioneso/moss/pull/1645)
- **More resilient note memory.** Moss can now remember notes containing unusual characters that used to stop the process. [PR #1636](https://github.com/motioneso/moss/pull/1636)
- **Downloaded modules restart properly.** The Settings prompt now gives a command that actually applies a downloaded module update. [PR #1658](https://github.com/motioneso/moss/pull/1658)

### Changed

- **Settings are closer to where you need them.** Finance, Job Search, and News pages now link to their own settings, so changing a connection or preference takes fewer clicks. [PR #1772](https://github.com/motioneso/moss/pull/1772)

## Edge channel — 2026-08-27

Edge builds include the stable history below plus the user-facing changes already available in
the current edge image. This section is intentionally build-bundled so it never advertises a
feature that is not present in the image you are running.

### Added

- **Sign in to Gemini from Settings.** You can now sign in to Google's Gemini command-line tool from Settings or the first-run wizard, the same way you already sign in to Claude and Codex. [PR #2042](https://github.com/motioneso/moss/pull/2042)
- **Install the Gemini command-line tool.** You can now install the Gemini command-line tool from the app, pinned to a known, verified version. [PR #2039](https://github.com/motioneso/moss/pull/2039)
- **Archiving status in Settings.** Settings now shows a short message if the daily chat archive to Notes couldn't run, so you know when it needs attention. [PR #1995](https://github.com/motioneso/moss/pull/1995)
- **Edit a saved medication.** You can now edit a medication's name, dose, or schedule after saving it, instead of removing it and adding it again. [PR #1989](https://github.com/motioneso/moss/pull/1989)
- **Add medications on any schedule.** You can now set up a medication on any schedule the app supports - every day, only on certain days of the week, every few days or weeks or months, monthly, or in a cycle of days on and days off - and see in plain words what you picked, along with the next three doses, before you save it. [PR #1985](https://github.com/motioneso/moss/pull/1985)
- **Save your chats to Notes.** You can now turn on a setting that saves a daily written copy of your chats into your notes, off by default, in a folder you choose. [PR #1980](https://github.com/motioneso/moss/pull/1980)
- **See your module build progress and get notified when it's done.** When you ask Moss to build you a new page and approve the plan, you're now taken straight to the Workshop page where you can watch it build, and you get a notification the moment it finishes or fails. [PR #1966](https://github.com/motioneso/moss/pull/1966)
- **Sports news source coverage.** Choose ESPN or custom publishers for entire sports, leagues, and teams to build a mixed news feed. [PR #1967](https://github.com/motioneso/moss/pull/1967)
- **Throw away a draft module.** If a module Moss built for you is not what you wanted, you can now delete it from the draft banner. [PR #1942](https://github.com/motioneso/moss/pull/1942)
- **Ask Moss for a new module right in chat.** Tell Moss what you want a new module to do and it will come back with a plan you can read and approve before any work starts. [PR #1940](https://github.com/motioneso/moss/pull/1940)
- **Fleet launcher and overnight viewer.** Start the fleet from one terminal screen, follow its lanes, pause work safely, and preview a rescue before starting it. [PR #1911](https://github.com/motioneso/moss/pull/1911)
- **Choose your weather place and temperature units.** You can choose the place used for your weather and switch temperatures between Celsius and Fahrenheit. [PR #1826](https://github.com/motioneso/moss/pull/1826)
- **Custom sports news sources.** You can now add your own sports news sources by URL in Sports settings, preview what Moss found, and assign them to your followed teams and leagues. [PR #1825](https://github.com/motioneso/moss/pull/1825)
- **Workshop page.** Admins now have a Workshop page showing which modules Moss is building, has finished, or has made live, with anything waiting on a decision from you called out first. [PR #1804](https://github.com/motioneso/moss/pull/1804)
- **Log a meal from the Food page.** The Food page now has its own Log a meal button, so you can
  add a meal without going through chat. [PR #1788](https://github.com/motioneso/moss/pull/1788)
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

- **Workshop build activity.** Workshop builds now keep moving after they start and show the last time the builder was confirmed active. [PR #2009](https://github.com/motioneso/moss/pull/2009)
- **ESPN images and stale page reloads.** Some ESPN game and team images were being blocked from loading, and a browser holding an old version of the page could get a confusing blank response instead of a clean "not found" when trying to reload; both are fixed. [PR #1996](https://github.com/motioneso/moss/pull/1996)
- **Workshop builds recover visibly.** Workshop builds now start reliably, show useful progress and failures, allow failed attempts to be discarded, and no longer show unreliable cost or time estimates. [PR #1991](https://github.com/motioneso/moss/pull/1991)
- **Chat archive now includes the whole day.** When you turn on chat archiving partway through the day, today's archived note now includes everything you chatted about earlier that day, not just messages sent after you turned it on. [PR #1988](https://github.com/motioneso/moss/pull/1988)
- **Readable chat archive headings, and no more backfilling old messages.** Each conversation in your daily chat archive note now shows a local time and the conversation's title instead of a raw computer timestamp. Also, turning archiving on partway through the day no longer pulls in messages you sent earlier that day before you turned it on. [PR #1984](https://github.com/motioneso/moss/pull/1984)
- **Workshop builds finish and respond.** The Workshop now completes builds, opens finished drafts, and responds when you stop, discard, revise, or share a module. [PR #1981](https://github.com/motioneso/moss/pull/1981)
- **Workshop buttons now work.** The Stop, Ask for a change, and Turn on for everyone buttons on the Workshop page now actually do something. [PR #1978](https://github.com/motioneso/moss/pull/1978)
- **Sports source assignment reviews.** Sports source coverage changes now work with existing feeds, and source cards show clean team and league badges instead of feed URLs. [PR #1977](https://github.com/motioneso/moss/pull/1977)
- **Workshop module builds.** Module builds no longer stall, and the Workshop only shows modules created by the signed-in user. [PR #1964](https://github.com/motioneso/moss/pull/1964)
- **Sports source setup and status layout.** Custom sports sources now recover legacy feed assignments and show clearer controls, team labels, status details, and errors. [PR #1956](https://github.com/motioneso/moss/pull/1956)
- **Custom sports sources now stay current.** Custom sports sources now refresh into Sports and Today, show accurate health, and offer clear recovery actions in Settings and through Moss. [PR #1929](https://github.com/motioneso/moss/pull/1929)
- **Polished everyday app screens.** Settings, tasks, navigation, notifications, and several module pages now use clearer labels, cleaner layouts, and more consistent controls. [PR #1938](https://github.com/motioneso/moss/pull/1938)
- **Latest releases appear first.** Recently Released now shows the newest Edge updates at the top, ahead of older weekly history. [PR #1908](https://github.com/motioneso/moss/pull/1908)
- **Clearer error messages when a built-in tool's connection breaks.** When a built-in assistant tool (like note search) fails because it can't reach something it depends on, the chat now shows a short, specific reason instead of a generic error. Note search also no longer fails outright when the built-in text-matching engine is in use. [PR #1892](https://github.com/motioneso/moss/pull/1892)
- **Photos and logos recover on their own.** A news photo or sports logo that failed to load because of a brief network hiccup now recovers on its own, instead of staying broken until you refresh the page. [PR #1874](https://github.com/motioneso/moss/pull/1874)
- **Job board shows a count when some roles can't be displayed.** The job-search board now tells you if it couldn't show some roles instead of leaving them out with no explanation. [PR #1844](https://github.com/motioneso/moss/pull/1844)
- **Activity log now shows failed actions as failed.** When the assistant tried to do something and the relevant app said it could not (for example, updating a task that no longer exists), the activity log used to record it as a success. It now correctly shows it as failed. [PR #1654](https://github.com/motioneso/moss/pull/1654)
- **Nav bar now switches color in dark mode.** The left navigation bar used to stay the same green shade when you switched to dark mode, out of step with the rest of the app. It now switches to match, like every other part of the interface. [PR #1810](https://github.com/motioneso/moss/pull/1810)
- **Private chat now stays closed correctly if the browser refocuses mid-close.** Fixed a rare case where switching away from the app while closing a private chat, then switching back, could leave the app showing the chat as closed even if the close didn't actually finish on the server. [PR #1801](https://github.com/motioneso/moss/pull/1801)
- **All-day events are seen when checking your calendar.** Availability is now checked a whole day
  at a time, so all-day entries are no longer missed when the assistant looks for free
  time. [PR #1786](https://github.com/motioneso/moss/pull/1786)
- **The assistant no longer says it did something when it only asked permission.** Granting a
  permission is reported as a permission grant, not as a finished action. [PR #1783](https://github.com/motioneso/moss/pull/1783)
- **Meals are logged on the right day.** Logging a meal late in the evening no longer files it under the next day. The assistant now uses your own timezone rather than guessing. [PR #1790](https://github.com/motioneso/moss/pull/1790)
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

### Changed

- **Sports honours your story preferences.** The Sports page now takes account of the stories you have asked to see more or less [PR #2050](https://github.com/motioneso/moss/pull/2050)
- **Workshop page shows your real builds.** The Workshop page now shows your actual in-progress and finished module builds instead of a placeholder. [PR #1948](https://github.com/motioneso/moss/pull/1948)
- **One image for Sports source previews.** Moss now includes Sports public-source previews in its existing download while keeping browser discovery isolated. [PR #1947](https://github.com/motioneso/moss/pull/1947)
- **Weather chip now shows a 5-day forecast with hover detail.** The weather chip at the top of the Today page now shows a 5-day forecast strip instead of just current conditions. Hover or tab to any day to see humidity, dew point, wind, and high/low, and click a day to open the full forecast for your location in a new tab. [PR #1939](https://github.com/motioneso/moss/pull/1939)
- **A new look for the weekly What's New page.** The weekly summary of what shipped now has a new design and is published again every Friday morning. [PR #1830](https://github.com/motioneso/moss/pull/1830)
- **The Food page uses the full width.** The Food page now lines up with the Finance and Job Search pages instead of sitting in a narrower column. [PR #1793](https://github.com/motioneso/moss/pull/1793)

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
