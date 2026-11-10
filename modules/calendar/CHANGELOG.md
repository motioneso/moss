# Calendar package

## 0.20.0

- Retain keyboard focus on the selected toolbar control after its view save finishes.
- Restore the authored grouped Day, Week and Month choices and Work week / Full week controls.
- Use compact arrow buttons and the existing small Today button in the toolbar.
- Compare rendered controls with the production screen and check installed navigation, keyboard use, saved choices and phone layout.
- Full cutover, provider execution and physical second-device acceptance remain open.

## 0.19.0

- Recenter Day and Week when a refresh receives a changed saved account timezone.
- Retain deliberate scrolling through later refreshes in the same timezone.
- Exercise real saved timezone and cache changes in the installed signed-in screen at desktop and phone widths.
- Full cutover, provider execution and physical second-device acceptance remain open.

## 0.18.0

- Open Day and Week with the current time centered in the measured visible grid, matching the existing screen.
- Keep the user's vertical scroll position, including midnight, through changed-data refreshes.
- Compare the actual production grid's scroll effect across heights and exercise the installed screen at desktop and phone widths.
- Keep Month overflow controls inside the event list at shorter viewport heights.
- Full cutover, provider execution and physical second-device acceptance remain open.

## 0.17.0

- Restore Month date highlights, first-of-month labels and equal row sizing with the existing minimum height.
- Omit empty time labels on all-day and continuation entries.
- Compare rendered Month dates and chips with the existing screen and check installed date, overflow and detail navigation at desktop and phone widths.
- Full cutover, provider execution and physical second-device acceptance remain open.

## 0.16.0

- Match timed-event label density: compact events keep their title, taller events show the time, and Day view shows locations when there is room.
- Restore held-event markers and the held all-day colour using the published Rust UI kit.
- Compare rendered labels with the production React grid and exercise the installed screen at desktop and phone widths.
- Full screen cutover, provider execution and physical second-device acceptance remain open.

## 0.15.0

- Restore the authored event details layout, markers and held-block note on the Rust screen.
- Keep long event titles and locations inside the panel at phone width.
- Exercise the installed dialog at desktop and phone widths, including Escape, Close and focus return.

## 0.14.0

- Read stored day-plan apply progress through the installed API and original URL,
  preserving item order, pending/completed status, results and denial guidance.
- Compare real installed responses with production and exercise the retained
  owner-only rules with a failing-first installed privacy witness.
- Provider execution, full screen cutover and physical second-device proof remain open.

## 0.13.0

- Return the original saved day-plan response with live task and source-run summaries beside the unchanged plan.
- Report unavailable references without losing the saved draft; reference lookups use the existing scoped public interface.
- Concrete production adapters, the day-plan editor, provider execution, full shell and physical second-device HTTPS remain open.

## 0.12.0

- Add a background job that removes one cached event for the account that queued it. An event the account cannot see is left untouched and reported as not removed.
- Nothing queues this job yet, and retry and retention settings use host defaults.
- Real worker-role dispatch is not proven here.

## 0.11.0

- Accept the original day-plan date field for draft creation and saves.
- Use the account timezone, or the product default, when creating without a timezone.
- Compare draft writes with production and exercise both URL prefixes after real browser sign-in.
- Source-linked creation, enriched plan reads and full Calendar acceptance remain open.

## 0.10.0

- Preview selected day-plan changes before applying: before and after times, task eligibility, deadline risk and overlaps between selected changes.
- Task facts arrive through the public task-reference link; a missing or foreign task reads as unavailable and is never distinguished.
- No provider source context exists in this host yet, so calendar availability reports unavailable instead of claiming time is free.
- The original day-plan read, create, draft and preview URLs dispatch through the installed package.
- Provider tools and jobs, execution, full shell and physical second-device trusted HTTPS remain open.

## 0.9.0

- Show a loading message before Calendar and settings start.
- Explain failed screen downloads and offer a parent-page reload that keeps event links.
- Check real installed startup faults and recovery at desktop and phone width.
- Full Calendar parity and physical second-device trusted HTTPS remain open.

## 0.8.0

- Keep midnight-ending events on the last covered day in their details.
- Match default English event-date and toolbar-range wording to the existing screen.
- Restore event swatches and today’s held-block count in the Day legend.
- Compare date labels with the production UI model and check the installed HTTPS screen.
- Full parity, regional formatting, provider execution and second-device trust remain open.

## 0.7.0

- Calendar labels, held-event details and settings follow the account's assistant name.
- Narrow week screens explain scrolling and bring today into view when opening or resizing.
- Ordinary refreshes keep the position chosen by the reader.

## 0.6.0

- Save account lookahead, prep-task and time-block choices from Calendar settings.
- Save the matching time-block permission atomically with settings.
- Keep confirmed values after failed saves and allow retry.
- Compare writes, stored preferences and policy against production routes; extend privacy controls.
- Provider actions, source-behavior controls, full shell and second-device acceptance remain open.

## 0.5.0

- Open linked events through the signed-in Calendar page and keep their details current.
- Show event duration, attendee grammar and status labels; show refresh progress.
- Dispatch original event and briefing-settings read URLs through the installed package.
- Compare real TypeScript read routes with installed Wasm and signed-in HTTPS responses.
- Full parity, provider execution, settings edits and second-device trust remain open.

## Unreleased

- Add packaged Rust Day, Week and Month screens, event details and view-only settings.
- Save display choices privately for each account; refresh through the module bridge.
- Compare screen date and overlap calculations with the production Calendar model.

- Add owned-cache heartbeat reads and untimed chat draft edits as package tools.
- Compare installed Wasm tools with production TypeScript on a disposable database.
- Add the Rust data package for cached events and private day-plan drafts.
- Reuse all five existing tables and all fifteen original migration files and ledgers.
- Full authenticated shell composition, settings writes, four remaining tools, jobs and execution remain open.

## 0.4.0 — signed-in Calendar page composition

- Connect installed Calendar screens and their data requests to Rust sign-in and HTTPS.
- Keep static package assets usable by opaque frames while private requests stay behind sign-in.
- Add sign-out, Calendar settings navigation, bounded host calls and a disposable live-browser check.
- Full shell/chat, provider execution, writable automation settings and second-device acceptance remain open.
