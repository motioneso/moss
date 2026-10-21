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

## Try the automatic body test (version 0.4.3)

1. Reload the add-on in `about:debugging`, then reload Outlook and leave it on
   **Inbox**. No permissions have been added.
2. In the extension's **Automatic body test** section, enter a fresh phrase such
   as `MOSS BODY TEST 3141`. Use a different suffix for each attempt. Click
   **Start automatic body test**, then close the popup and leave the tab untouched.
   Starting stops the passive watchers. Existing matching rows prevent starting.
3. From another window/device, send a new synthetic conversation to yourself.
   Put the exact phrase in its subject and body, add several invented paragraphs,
   and put `MOSS BODY END` on the final line. Do not reply to real mail.
4. Once Outlook displays the row, the test clicks it **once**. This may mark it
   as read; it does not restore unread status. Reopen the popup and click
   **Show body result**. Check locally whether the final marker appears.
5. Report only the generic status/counts and whether the end marker appeared.
   Click **Stop & clear body** afterward. Do not send the body or screenshots.

This is one-shot automation, not a mailbox crawler. It waits up to five minutes
for a newly displayed matching row among the first 50 rendered options, rejects
multiple matches, and allows twenty seconds after the single click for rendering.
Its own click may change the mail route; unrelated route changes before clicking
stop the run. Trusted pointer/keyboard interaction in the page stops and clears it.
No automatic retries, scrolling, sending, deletion, folder navigation or startup.

The shared opened-message reader checks the nearby subject for the phrase before
reading body text. Capture requires one visible message body, the phrase in that
body, its final marker, no truncation, and two equal snapshots. Unsupported layouts
or incomplete rendering time out without retaining a result. These markers test
the synthetic render; they are not authoritative message IDs or proof of complete
mailbox coverage. Body capture is bounded to 12,000 characters. One result stays
in tab memory across popup closure until Stop, reload or tab close. Restart and
session recovery remain unimplemented. A live one-shot automatic body trial succeeded
on 2026-10-21 with version 0.4.3; see the result below.

The automatic test searches up to twelve ancestor wrappers (depths 0–11), comparing
at most 100 headings per wrapper and 500 characters per heading. It continues past
unrelated intermediate headings until one subject-like heading contains the full
test phrase. Multiple matching headings fail identity validation. Main/page,
message-list/navigation and multiple-body boundaries still stop the search.
Manual preview without a phrase retains its first-subject-candidate heuristic;
its subject field can still be missing or inaccurate in unfamiliar layouts.

## Deliberately narrow behavior

### Diagnose a missing subject (version 0.4.2)

After a failed synthetic body trial, reload the extension and Outlook, then
manually reopen that synthetic message. Enter its exact subject test phrase in
the automatic body's phrase box and click **Check subject layout**. No new email
or automatic run is needed. Copy only the resulting **Layout check** report.

This explicit diagnostic compares the phrase against readable headings outside
the selected body, examining up to twelve ancestor containers (stopping after
the first main region or before the page body). Per container it reports numeric
body/list/navigation/heading counts, main-region status, and the number of
headings containing the phrase. It considers at most 100 headings per container
and 500 characters per heading. It returns fixed labels/counts only, excluding
heading text, addresses, IDs, attributes, and body text. The popup clears its
displayed body result before showing the report; nothing is saved or uploaded.
This does not change the extractor's boundary or relax subject verification.

The version 0.4.1 live repeat still reported **Subject heading missing or does not
match test phrase** after opening one row. The nested-wrapper fix passed its
synthetic fixture but did not resolve the real layout. The structural report is
the next diagnostic step at that stage; automatic capture was still unverified.

### Boundaries

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
  missing or incorrectly identified in an unfamiliar Outlook layout. A sender
  heading may use `From:` or a displayed email address. Sender/date-only nested
  wrappers do not end the bounded search for an outer subject heading. No address
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
Body-mode checks use a controlled clock with the production interval callback:
one click after arrival, own-click mail route change, stable complete capture,
stale subject rejection, missing end marker, multiple rows/bodies, compose exclusion,
trusted interaction, Stop, timeout and navigation shutdown. Removing the subject
identity guard exposes a stale-pane capture in the synthetic fixture, demonstrating
that the guard matters. Popup retrieval and tab-memory retention are checked with
mocked browser APIs; installed Firefox/Outlook behavior still needs the live trial.
Nested-header checks reproduce a sender heading hiding an outer subject in the
previous reader, then verify separate subject/sender fields and automatic capture.
Missing subjects stay unknown; main-region titles and body headings cannot provide
subject identity. Pending/timeout statuses name the failed capture check without
including message text.
Layout-report checks cover outer/main headings, excluded hidden/list/body
headings, ancestor bounds, ambiguous bodies, exact report serialization, and
popup wiring without starting a test. Appending raw body text in an isolated
mutated diagnostic makes the exact-report assertion fail.
The depth-11 fixture reproduces the reported shallow search failure with unrelated
intermediate headings. It covers automatic capture, rejected duplicate subjects,
the depth-12 limit, and main/list/navigation boundaries.
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
row. At that stage full bodies, restart recovery and VM operation were untested;
subsequent calendar and body trials are recorded below.

First calendar watcher live trial (2026-10-21): the user reported that initial appearance
worked when the event was created on another computer. Rename and deletion were
not observed; those actions were performed in the watched tab. That trial did not
verify update or disappearance handling.

A synthetic check of the current source confirmed that changing from a calendar
view URL to an editor URL stops the watcher and clears observations by design.
The user subsequently reported **Stopped (calendar): Calendar route changed;
stopped and cleared**, after 46 scans. This confirms a live route interruption;
the zero observation counters reflect clearing and do not establish extraction
failure. An uninterrupted repeat was needed to test rename/disappearance.
For the isolated collection trial, create, rename and delete on the other
computer while leaving the watched tab's date/view unchanged. No route guard was
relaxed on the basis of this report. The initial result does not establish stable
event identity, reliable cancellation detection, restart recovery or VM operation.

Uninterrupted calendar repeat (2026-10-21): the user reported the following while
leaving the watched view unchanged and making changes on the other computer.
The watcher remained Running (calendar) throughout.

| User action | Scans | Rendered items | Phrase matches | Newly observed/changed | No longer displayed |
| --- | --- | --- | --- | --- | --- |
| Create | 19 | 15 | 1 | 1 | 0 |
| Edit | 46 | 15 | 1 | 2 | 0 |
| Delete | 62 | 14 | 0 | 2 | 1 |

This supports live detection of appearance, a changed summary, and disappearance
in the displayed Outlook calendar during this bounded trial. It does not establish
stable event IDs, authoritative cancellation semantics, complete calendar coverage,
or recovery after session/browser interruption. No event content was supplied.

First automatic body trial (2026-10-21, version 0.4.0): the user confirmed the
matching email opened automatically, while capture remained pending. A manual
preview could read the body through its final test marker, but labelled a sender
heading as Subject and left From unknown. This explains rejection by the automatic
subject-phrase check. Actual DOM structure was not inspected. A synthetic nested
sender/date wrapper with a subject in its parent reproduced that field mix-up.
Version 0.4.1 recognizes address-shaped sender headings and continues through
sender/date-only wrappers within the existing five-level single-message boundary.
The subject identity requirement remains in place. Generic diagnostics distinguish
missing/mismatched subject, unreadable/ambiguous body, size limit, missing body
phrase/end marker and pending stable snapshots, including after timeout.
At that stage the corrected extractor still needed a live repeat; automatic body
capture had not yet been established. No mailbox content is retained in these notes.

Version 0.4.2 live layout diagnosis: the report showed one readable body throughout
depths 0–11, no main/list/navigation boundaries at those levels, and zero phrase
headings through depth 10. At depth 11 there were five readable headings with one
phrase match. This establishes that the prior five-wrapper search could not reach
the matching heading. Unrelated headings earlier in the path also made the prior
early-exit rule unsuitable for the automatic test. Version 0.4.3 raises the bound
to twelve wrappers and searches specifically for a unique phrase-matching heading
in automatic mode. A synthetic fixture reproducing both conditions failed before
the change. The subsequent live repeat succeeded, as recorded below.


Successful automatic body repeat (2026-10-21, version 0.4.3): the user reported
**Stopped: Captured one synthetic body locally; automation finished**, with
38 scans, one row opened, and **body captured: yes**. This verifies one explicitly
started live path from a newly displayed matching row through automatic opening
to local body capture in this account/browser. The capture code requires a matching
subject heading, the body phrase, the final marker, no truncation and two equal
snapshots before reporting success. Stopped is the expected one-shot completion.
No body content was requested or retained for this success report.

This completes the one-message capture experiment. Continuous multi-message
collection, complete mailbox/calendar coverage, long-lived session reliability,
reload/browser restart recovery and VM operation remain untested or unimplemented.
The extension is still a local disposable prototype, with no Moss ingestion.
Use **Stop & clear body** after checking the result to discard the tab-local capture.

### Autonomous Chrome continuation (2026-10-21)

With explicit authorization for at most five invented Gmail-to-Outlook messages,
five messages were sent through Gmail's compose UI to the signed-in Outlook
account. Existing version 0.4.3 scripts were injected through Chrome DevTools into
an isolated JavaScript world. No Chrome extension was installed; these results
exercise the reader and watcher, not Chrome add-on installation or permissions.

| Trial | Result | Scans | Rows opened |
| --- | --- | --- | --- |
| Outlook foreground | Synthetic body captured | 13 | 1 |
| Gmail brought to foreground (visibility unverified) | Synthetic body captured | 15 | 1 |
| Outlook reload, then explicit reinjection/start | Synthetic body captured | 13 | 1 |
| Minimized browser, controller disconnected | Synthetic body captured | 13 | 1 |

Each success required the existing subject/body phrase, final marker and stable
snapshot checks. Only status/count summaries were returned to the controller;
captures were cleared after each trial. No real message bodies or account
addresses are retained in this evidence.

A fourth trial disconnected the controller, but Outlook reported itself visible.
It was stopped while still waiting for delivery (13 scans, zero rows opened);
this establishes neither capture nor a delivery failure. Bringing Gmail forward
alone did not establish hidden-tab scheduling in this controlled browser.

For the fifth message, the test browser was minimized and the controller
disconnected. A page-local two-second visibility sampler subsequently recorded
24 hidden samples and one visible sample; on reconnection the probe reported
success with one row opened and 13 scans. This supports a short unattended
capture with an observed hidden interval, not sustained background reliability.
The exact visibility at the instant of capture was not separately recorded.
All five authorized send attempts were used; no further messages were sent.

The reload trial first confirmed that the probe was absent after navigation.
Recovery therefore required the controller to reinject and explicitly start it;
the current add-on does not recover automatically. These short trials do not
establish persistent authentication, hours-long scheduling, a VM deployment,
complete mailbox coverage or continuous multi-message ingestion.
