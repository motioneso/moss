# Disposable Firefox Outlook preview

Question: can a user-invoked Firefox add-on preview one already-opened Outlook Web
message without a new Microsoft app registration? This is a standalone experiment,
not a Moss connector. Real Outlook extraction and temporary add-on installation
remain unverified until the manual trial below.

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
6. Close the popup to discard the preview. To remove the add-on, click **Remove**
   in `about:debugging`. Temporary add-ons also disappear when Firefox restarts.

If workplace policy blocks add-ons, stop there. This does not establish employer
approval and cannot guarantee the absence of security alerts. It uses the current
Outlook tab, without a separate Microsoft sign-in or app registration.

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
- No attachments, mailbox enumeration, sync, persistent login support, or upload.
  Outlook DOM changes can break the experiment.

## Checks

Run `python3 verify.py` with existing Python Playwright and its Firefox binary.
It launches an isolated Firefox on synthetic HTML; popup checks use a mocked
`browser` API. It writes a plan, logs, and a cropped popup screenshot to a temporary
directory. It does not open Outlook or test actual extension installation, CSP
enforcement in an installed add-on, or Firefox's permission grant behavior.

The synthetic checks cover one-message extraction, surrounding inbox/compose and
hidden text exclusion, missing/ambiguous rejection, output bounds, safe text
rendering, clearing, host validation, and injection errors. Manifest validation:

```sh
npx --yes web-ext@10.8.0 lint --source-dir spikes/o365-firefox-preview-prototype --ignore-files verify.py README.md
```

Manual trial result: **pending**. No live mailbox content belongs in this folder.
