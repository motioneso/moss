# Disposable Firefox Outlook preview

Questions: can a user-invoked Firefox add-on preview an opened Outlook Web message,
and watch rendered Inbox rows or Calendar events after an explicit Start, without a new Microsoft app
registration? This is a standalone experiment,
not a Moss connector. A user-reported Firefox/Outlook trial succeeded on
2026-10-21, with the sender field missing; see the result below.

## Try it (Firefox desktop 142 or later)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder
   (`~/Jarv1s/spikes/o365-firefox-preview-prototype` in the main checkout; use the
   corresponding folder in the discussion checkout if working there).
3. In Outlook Web, manually open a synthetic email with invented subject, sender
   content, and body. Use a single message, close drafts, and avoid a conversation
   containing real emails. Do not use confidential mail for this trial.
4. Click Firefox's Extensions puzzle icon, choose **Outlook local preview —
   prototype**, then click **Preview opened email**. Nothing is read until that
   button is clicked.
5. Check the preview locally. Report only success, missing field names, or the
   generic status message; do not send email text or mailbox screenshots.
6. Close the popup to discard the opened-email preview. To remove the add-on, click **Remove**
   in `about:debugging`. Temporary add-ons also disappear when Firefox restarts.

If workplace policy blocks add-ons, stop there. This does not establish employer
approval and cannot guarantee the absence of security alerts. It uses the current
Outlook tab, without a separate Microsoft sign-in or app registration.

## Try the automatic inbox watcher (version 0.2.0)

1. If version 0.1.0 is loaded, click **Reload** for this add-on in
   `about:debugging#/runtime/this-firefox`. Reload the Outlook tab too, then leave
   it on **Inbox**. The permissions have not changed.
2. Open the extension popup. Leave the synthetic test phrase as `MOSS TEST` (or
   choose another distinctive phrase of 3–80 characters). Click **Start watching**.
   Initial matches are labelled **Already visible at start**.
3. Close the popup and leave the Outlook tab open. From another window/device,
   send yourself a synthetic email with `MOSS TEST` in the subject. Do not open it
   in the watched tab. Wait for Outlook to display its row.
4. Open the extension again and click **Show results**. Look for increasing scan
   counts and a **Newly observed or changed row** containing your synthetic subject.
   No reading happens automatically just from reopening the popup; this button
   retrieves the existing watcher's tab-local results.
5. Click **Stop & clear** before leaving the experiment. This stops its timer and
   clears its retained row summaries and deduplication state. Reloading/closing
   the Outlook tab also discards the watcher. A detected URL route change stops
   and clears it. After a reload you must click Start again.

If no supported message list is found, report that status and the numeric counts
only. Do not send mailbox text, DOM dumps, or screenshots. Outlook inbox selectors
worked in the first reported live trial; other layouts remain unverified. The watcher requires a single visible `role=listbox`
whose `aria-label` includes Message, Conversation or Inbox (English).

The watcher checks every two seconds while the browser schedules its timer; a
background tab may be throttled or discarded. It reads up to 50 rendered options,
keeps only test-phrase matches, caps each summary at 2,000 characters, keeps the
latest 20 observations and at most 500 summaries for deduplication in tab memory. A matching
row includes whatever text Outlook renders there, potentially sender, subject,
time and a body snippet. Those fields are not parsed or guaranteed complete.
Do not put the test phrase in real/confidential conversations.

The inbox watcher does not scroll, click, open messages, fetch full bodies, navigate folders,
inspect calendar, or automatically resume after reload/browser restart. It cannot
guarantee new-email identity: changed timestamps/read states, scrolling, Focused /
Other tabs, conversations and virtualization can produce misses or repeats.
Results show observations, not a reliable mailbox change feed. No VM was created.

## Try the calendar watcher (version 0.3.0)

1. Stop the existing watcher, reload this add-on in `about:debugging`, then reload
   Outlook. Open **Calendar** and leave it on the week containing your test event.
2. Open the extension and click **Start watching**, keeping the phrase `MOSS TEST`.
   It automatically chooses the calendar watcher when the active Outlook URL
   contains `/calendar`. Close the popup and leave this view open.
3. In another tab/window, create a personal calendar event with **no attendees**,
   titled `MOSS TEST calendar`, within the displayed week. Wait for it to appear
   in the watched calendar, then reopen the extension and click **Show results**.
   Look for a phrase match and **Appeared / changed summary in displayed calendar**.
4. In the other window, rename it to `MOSS TEST calendar updated`, keeping the test
   phrase. Wait for Outlook to display the update and use **Show results** again.
   The updated label should appear; the former label should become **No longer
   displayed — not proof of cancellation** after two absent scans.
5. Delete that personal test event in the other window. Once it disappears from
   the watched view and two more scans pass, Show results should record the updated
   label as no longer displayed. Report only counts/status and whether those three
   observations occurred. Do not share actual event labels or calendar screenshots.
6. Click **Stop & clear**. Navigation/reload discards the watcher; it does not
   automatically restart. If Outlook itself does not update the watched view,
   report that separately; the watcher cannot discover changes absent from its DOM.

This probe reads matching, event-like button labels within a single visible
`main`/`role=main` region on a calendar URL. It excludes navigation, dialogs and
editors and requires a displayed time or English All day in the button label.
It uses `aria-label` where supplied (otherwise rendered button text), so summaries
may include event title, time and other accessible event details. Actual Outlook
calendar selectors remain unverified. A zero candidate count may mean an empty
calendar or an unsupported layout; it is not proof of calendar access.

Every scheduled two-second scan considers at most 500 visible buttons, 200 time-like
labels, and 50 matching unique summaries. Summaries are capped at 2,000 characters;
the last 20 observations are retained in tab memory, together with the current
matching set and one-scan disappearance grace state. No event IDs or authoritative
change feed are available. Identical labels may merge; title/time changes produce
appearance plus disappearance, not a proven update to one identified event.

Keep the same date, view, selected calendars and scroll position. Filtering,
scrolling, loading, virtualization and view changes can make events disappear.
Two absent scans reduce brief rerender noise but cannot establish deletion or
cancellation. This experiment does not open, create, edit or delete events, click
through dates, read invitations from mail, or sync a complete calendar.

## Deliberately narrow behavior

- Only `activeTab` and `scripting` permissions. No host permissions, background
  scripts, automatic content scripts, cookies, token access, or storage APIs.
- The popup accepts only HTTPS `outlook.office.com`, `outlook.office365.com`, and
  `outlook.live.com`. The extractor reads the top frame only.
- Source contains no network requests or Moss connection. Popup CSP disallows
  connections. Mail fields are rendered as plain text, never HTML.
- Selects one visible `[role="document"][aria-label="Message body"]`, excluding
  compose editors and list/navigation ancestors. Multiple visible bodies fail.
  Unsupported layouts and localized labels fail without a page-text fallback.
- Sender, subject, and displayed date use nearby headings only; they may be
  missing or incorrectly identified in an unfamiliar Outlook layout. No address
  book access or date conversion. Hidden descendants and controls are omitted
  from body text; body preview is limited to 12,000 characters.
- Quoted history inside the selected message can appear in the body. This is
  another reason to use a synthetic email containing only invented text.
- No attachments, complete mailbox enumeration, sync, persistent login support, or upload.
  Outlook DOM changes can break the experiment.

## Checks

Run `python3 verify.py` with existing Python Playwright and its Firefox binary.
It launches an isolated Firefox on synthetic HTML; popup checks use a mocked
`browser` API. It writes a plan, logs, and a cropped popup screenshot to a temporary
directory. It does not open Outlook or test actual extension installation, CSP
enforcement in an installed add-on, or Firefox's permission grant behavior.

The synthetic checks cover one-message extraction, surrounding inbox/compose and
hidden text exclusion, missing/ambiguous rejection, output bounds, safe text
rendering, clearing, host validation, and injection errors. Watcher checks also
cover timer-driven row detection with the popup closed, test-phrase filtering,
deduplication, repeat script loading, Stop/clear, route change shutdown, and popup
controls. The watcher runs on synthetic Outlook-shaped HTML, not a live mailbox.
Calendar checks cover test-phrase filtering (including an assertion observed to
fail when the filter guard is removed), automatic appearance, changed labels,
two-scan disappearance, deduplication, repeat script loading, stop/clear, route
shutdown, and the popup's automatic calendar-mode selection with mocked APIs.
Manifest validation:

```sh
npx --yes web-ext@10.8.0 lint --source-dir spikes/o365-firefox-preview-prototype --ignore-files verify.py README.md
```

Manual trial result (2026-10-21): the user reported the Firefox trial worked, with
only **From** showing **Not found**. This supports feasibility of the user-invoked
preview in that account/browser. Sender extraction remains unresolved: the current
code recognizes only a nearby heading beginning with `From:`; the actual sender
markup has not been inspected. This trial does not establish full mailbox sync,
compatibility with other tenants, employer approval, or absence of security alerts.
No live mailbox content belongs in this folder.

Automatic inbox watcher manual trial result (2026-10-21): the user reported
**Running: Watching rendered rows only**, with 34 scans, 15 rendered rows,
one phrase match and one newly observed/changed row. This confirms the watcher
ran and recorded a matching row in the live Outlook layout. Counts alone do not
prove that the observation was a newly delivered message rather than a changed
row. Full bodies, calendar events, restart recovery and VM operation remain untested.

Calendar watcher live trial (2026-10-21): the user reported that initial appearance
worked when the event was created on another computer. Rename and deletion were
not observed; those actions were performed in the watched tab. Live update and
disappearance handling remain unresolved pending watcher status and a repeat with
the watched tab left unchanged.

A synthetic check of the current source confirmed that changing from a calendar
view URL to an editor URL stops the watcher and clears observations by design.
This is a possible explanation, not a verified cause of the live result. Before
retesting, inspect **Show results** for Running versus Stopped/route changed.
For the isolated collection trial, create, rename and delete on the other
computer while leaving the watched tab's date/view unchanged. No route guard was
relaxed on the basis of this report. The initial result does not establish stable
event identity, reliable cancellation detection, restart recovery or VM operation.
