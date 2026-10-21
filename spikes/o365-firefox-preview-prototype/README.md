# Disposable Firefox Outlook preview

Questions: can a user-invoked Firefox add-on preview an opened Outlook Web message,
and watch rendered Inbox rows after an explicit Start, without a new Microsoft app
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
only. Do not send mailbox text, DOM dumps, or screenshots. Actual Outlook inbox
selectors are unverified. The watcher requires a single visible `role=listbox`
whose `aria-label` includes Message, Conversation or Inbox (English).

The watcher checks every two seconds while the browser schedules its timer; a
background tab may be throttled or discarded. It reads up to 50 rendered options,
keeps only test-phrase matches, caps each summary at 2,000 characters, keeps the
latest 20 observations and at most 500 summaries for deduplication in tab memory. A matching
row includes whatever text Outlook renders there, potentially sender, subject,
time and a body snippet. Those fields are not parsed or guaranteed complete.
Do not put the test phrase in real/confidential conversations.

This does not scroll, click, open messages, fetch full bodies, navigate folders,
inspect calendar, or automatically resume after reload/browser restart. It cannot
guarantee new-email identity: changed timestamps/read states, scrolling, Focused /
Other tabs, conversations and virtualization can produce misses or repeats.
Results show observations, not a reliable mailbox change feed. No VM was created.

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

Automatic inbox watcher manual trial result: **pending**.
