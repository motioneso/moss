# Meetings: minimal meeting screen

Status: draft design brief for review; not approved for build
Issue: #2981 (native meeting capture)
Builds on: `docs/superpowers/specs/2026-10-03-meeting-companion.md`
Mockups: `docs/superpowers/mockups/meetings-minimal/` (open `index.html`)
Critique: `docs/superpowers/mockups/meetings-minimal/critique.md`

## Direction

Ben, 2026-10-05:

> "Make sure we have impeccable critique it, and critique it hard (especially all of the settings
> and buttons, those should not be required for every meeting nor should it be so much up top.
> Look at meetily and other apps to see how minimal it should be (pretty much just transcript and
> a spot for notes, and the chat can dock like it does normally and the user can chat with Moss
> about the transcript."

Follow-up, 2026-10-05: sources, permissions and defaults become a one-time setup after the module
is installed; no per-meeting setup.

Correction, 2026-10-05, which overrides the follow-up on one point:

> "Sorry not right away, the user should click start once they are ready."

New meeting opens the meeting page without recording. One Start click records, with no questions,
using the one-time defaults.

## Goal

- A meeting is New meeting, then Start. Nothing else is required.
- The meeting page is a transcript and a place for notes, across the full width.
- Moss chat is the normal docked drawer, scoped to the open meeting.
- Every per-meeting setting and button moves to a one-time setup and to Settings, Meetings.

## Current flow, per meeting

Read from `packages/meetings/src/web/` on this branch (head `28a5a6beb`).

1. Masthead hero ("Meeting companion"), then "01 Set up your meeting": title, three capture-mode
   radio cards, a "Use this capture mode as my default" switch.
2. "02 Check the sources": open Trail Marker on the Mac, choose Prepare this meeting.
3. Back in Moss: "Allow <device> to capture <title>?", Approve this device ("This approval is for
   this meeting").
4. Pick the microphone, pick the app if selected-app.
5. Tick "Participants have been notified and recording is permitted".
6. Record.

Six steps across two apps before the first word is captured. The critique counts nine options on
the setup screen before a meeting exists, and about seventeen on the meeting page before Record.

## Target flow

| Moment        | What the user does                        | What they see                                                              |
| ------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| After install | Runs the one-time setup (mockup screen 2) | Link Mac, permissions, defaults, recording notice                          |
| New meeting   | One click                                 | Meeting page, not recording, Start button (screen 3)                       |
| Ready         | Start                                     | Recording begins with the saved defaults; timer, pause, stop (screen 4)    |
| During        | Types notes, asks Moss                    | Live transcript beside notes; chat drawer answers with timestamp links     |
| Stop          | Stop                                      | Summary writes itself; transcript beside Notes and Summary tabs (screen 5) |

If the user presses New meeting before finishing setup, the setup opens first, then lands on the
ready page. Setup can be reopened from Settings, Meetings with Run setup again.

## One-time setup

Shown once after install, on the Meetings page and in the module install flow. Three sections,
hairline-ruled, numbered heads (screen 2).

1. Your Mac
   - Link Trail Marker to this account once.
   - Status row: device name, app version, Linked.
2. Permissions
   - Microphone and computer audio, each Allowed or Not allowed yet.
   - Not allowed yet offers Open System Settings and Check again.
   - Computer audio may be skipped; the default then falls back to microphone only, and the
     footer says so.
   - Transcripts and summaries: Ready when a transcription route and a summary-capable model are
     configured, otherwise a link to Settings, AI providers. Say plainly that CLI models cannot
     write summaries today.
3. Defaults
   - Listen to: Microphone and computer audio (recommended), Microphone and one app, Microphone
     only.
   - Microphone: System default or a named device.
   - Meeting app: shown only for Microphone and one app.
   - Write a summary when I stop: on.
   - Recording notice: "I will tell people when I am recording", asked once here.
4. Finish setup. Saves preferences and marks setup complete.

## Meeting page

### Keep

- Meeting title, editable inline; defaults to "Untitled meeting" and is renamed from the summary
  when one is written.
- Date and time, quiet, next to the title.
- Transcript with source labels ("You", "Call audio"), timestamps, live line muted.
- Notes, autosaved with a quiet "Saved". Notes stay on screen when recording starts (today the
  page switches to the transcript tab, meeting-record.tsx:115-117).
- The notes conflict view, the unload warning while recording, and notes kept across navigation.
- Summary after stop, as a tab beside Notes.
- Suggested tasks at the end of the summary, one row each with Add to Tasks. Pressing Add is the
  owner review; the "Create in my Tasks after owner review" switch goes. A possible duplicate shows
  as one inline line, no switch. Transcript evidence stays on each row.

### Change

- Record control becomes one compact pill at the top right: red dot, elapsed time, pause, stop.
  Before recording it is a single primary Start button.
- One line under the title before recording names the source with a Change link to Settings,
  Meetings ("Microphone and computer audio. Change").
- Layout: transcript and notes split the full content width (about 1.35 to 1). With chat open the
  split shares the space left of the drawer. No empty gutter at 1440.
- Problems (Mac offline, permission revoked, transcription down) show as one inline message under
  the title with one fix button. The manifest's existing error codes and remediations stay.
- Overflow menu holds the rare actions: Search transcript, Rewrite summary (template choice
  inside), Earlier versions, Save to vault, Copy as Markdown, Delete meeting.
- Gaps in capture show as inline markers in the transcript ("0:42 to 0:55 missing"), not a list.
- One polite live region for new transcript lines; status changes announce once.

### Copy

- "Meeting", never "draft", on every screen and in the delete dialog.
- Drop "retained", "provisional", "Output scope", "Source labels only", template version suffixes.
  An unfinished transcript reads "Still being finalised".
- A missing capture route maps to "Recording isn't available on this server yet", not "Sign in
  again" (capture-panel.tsx:170).
- Delete the hardcoded "Capture: Unavailable" values (meeting-history.tsx:259,
  meeting-history-rail.tsx:47, 135-137).

### Remove from the meeting page

| Today                                                          | Goes to                                             |
| -------------------------------------------------------------- | --------------------------------------------------- |
| Masthead hero and "View meeting history" button                | Removed; the list is the history (`/meetings`)      |
| "Set up your meeting" section                                  | One-time setup                                      |
| Capture-mode radio cards                                       | Settings, Meetings: Listen to                       |
| "Use this capture mode as my default" switch                   | Removed; the setting is the default                 |
| "Check the sources" section, Prepare this meeting instructions | One-time setup: Your Mac                            |
| Approve this device, per meeting                               | One-time Mac link (see Security)                    |
| Microphone and app pickers                                     | Settings, Meetings                                  |
| Per-meeting consent checkbox                                   | One-time recording notice                           |
| Disconnect device, Stop and disconnect device                  | Settings, Meetings: Unlink                          |
| Retry capture command, Refresh capture status                  | One inline problem message with one fix             |
| Summary template select, Generate summary                      | Summary writes on stop; Rewrite summary in the menu |
| Generate new version, Compare with latest, Edit this version   | Menu: Earlier versions; edit inside the Summary tab |
| Save notes button                                              | Autosave with "Saved"                               |
| Any bespoke chat panel                                         | The normal docked chat drawer                       |

## Meetings list

Screen 1. Page heading "Meetings", search across titles, notes and transcripts, one New meeting
button. Rows grouped by week, ruled: when, title with a one-line gist from the summary, length.
No hero. Empty state follows `docs/design-system.md`: one line and the New meeting button.

- A row click opens the meeting. The side rail, Open review and its fact list go.
- The state filter, the word-limit hint, and the Capture, Processing and Vault columns go.
- "Pick up the conversation" goes; the chat drawer can answer across meetings.

## Chat

Today the normal drawer on a meeting page does not know the meeting and shows generic prompts.
Only the bespoke Ask Moss button (meeting-record.tsx:239-246, meeting-history-rail.tsx:93-101)
attaches it, and that button stays disabled until a transcript exists.

- The top-bar chat button opens the normal docked drawer. On a meeting page it attaches the open
  meeting by itself, shown as a removable "About this meeting" chip.
- Context is the transcript so far plus the notes, so chat works before any transcript exists.
- Composer placeholder "Ask about this meeting...".
- Answers cite transcript timestamps as links that scroll to and highlight the line in the
  transcript pane (replaces the citation panel above the tabs).
- Works during recording and after.
- Remove both Ask Moss buttons and their hints.
- Existing provider rules stand (app map: selected-meeting questions use the API-key chat model).
- Wiring: `meeting-chat-drawer.tsx` and the meeting chat surface in `apps/web/src/shell/app-shell.tsx`
  already exist; the change is choosing that surface from the route instead of from the button.

## Still recording elsewhere

While a meeting records and the user is on another page, the Meetings nav item shows a small red
dot and the top bar shows the elapsed time with a link back. Pause and stop stay on the meeting
page only.

## Settings, Meetings

Screen 6. Module settings at `/settings?section=modules&module=meetings`, following Backtrack's
declaration pattern.

| Section         | Rows                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| Your Mac        | Linked device and permission state; Unlink; Run setup again                                   |
| Recording       | Listen to; Microphone; Meeting app (selected-app only); Recording notice with date and Review |
| After a meeting | Write a summary when I stop; Summary style                                                    |

Every value is set in the app. No setting needs a hand-edited file.

## Data and API changes

### Preferences

`packages/shared/src/meeting-preferences-api.ts` grows from `defaultCaptureMode` alone to:

| Field                   | Type                                        | Default                      |
| ----------------------- | ------------------------------------------- | ---------------------------- |
| `defaultCaptureMode`    | existing enum or null                       | `computer-audio` after setup |
| `defaultMicrophoneId`   | string or null                              | null (system default)        |
| `defaultAppBundleId`    | string or null                              | null                         |
| `summarizeOnStop`       | boolean                                     | true                         |
| `summaryTemplateId`     | existing template id                        | general meeting              |
| `noticeAcknowledgement` | `{ policyVersion, acknowledgedAt }` or null | null                         |
| `setupCompletedAt`      | timestamp or null                           | null                         |

Existing rows migrate with the new fields at their defaults and `setupCompletedAt` null, so current
users see setup once. Module SQL lives in `packages/meetings/sql/`; add a new migration file.

### Recording notice

The client sends `noticeAcknowledged: true` on every start today
(`packages/shared/src/meeting-capture-api.ts:98`), and `capture-domain.ts` rejects a start without
it. Change: the server reads the stored acknowledgement and binds its policy version to the
session, as the original spec requires ("Start binds ... notice acknowledgement"). If the stored
version is older than the current notice, Start returns a prerequisite error and the page asks
once, then starts.

### Start

- One request from the meeting page starts capture on the linked Mac with the saved defaults.
- Trail Marker must accept a start for a linked device without a per-meeting "Prepare this
  meeting" click on the Mac. This is native app work and the largest build item.
- Pause, stop, the stop cutoff and the existing capture lease limits are unchanged.

## Security

Moving device approval from per meeting to a one-time link changes the capture trust model. This
brief does not claim the new model is equivalent. Before build:

- Write down what a stolen or left-signed-in link could do, and the revoke path (Unlink, and from
  the Mac).
- Keep a per-meeting capture lease issued at Start, bounded as today.
- Keep "recording" visible on the Mac for the whole session.
- A security review signs off the link design. Tests that assert revoke or expiry must be seen
  failing with the protection removed.

## Shared fix

The capture-mode radios render as 347x40 white discs because the global rule
`input, select, textarea { width: 100% ... }` (apps/web/src/styles.css:134) beats the shared
radio-card style. The radios move to setup and settings, so fix it at the source: scope the global
rule to text-like inputs, or harden the radio-card primitive in `packages/ui`. Check every other
radio-card screen.

## App map

Same PR as the build.

- `packages/meetings/src/manifest.ts`
  - Add a `settings` entry for Meetings module settings (`/settings?section=modules&module=meetings`).
  - Rewrite `meetings.capture_default`: defaults live in Settings, Meetings and the one-time
    setup; no per-meeting setup.
  - Rewrite `meetings.native_capture` and `meetings.transcript_review`: a linked Mac, one Start.
  - Rewrite `meetings.draft_records`: Notes and Summary tabs, summary on stop, menu actions.
  - Update `meeting_capture_unavailable` text: "approve this device again for the meeting" becomes
    the link and Run setup again path.
  - Add a feature entry for the one-time setup and the recording notice.
- `packages/shared/src/app-map-core.ts`: check the meeting chat wording still matches the drawer.

## Release note

The docs PR carrying this brief is `Category: N/A`. The build PR is user-facing: Category Changed,
title "Simpler meetings", one plain sentence such as "Start a meeting with one click; recording
choices now live in Settings."

## Acceptance checks

1. After setup, New meeting then Start begins recording; no other click or question.
2. The meeting page has no capture-mode, device, consent, template or generate controls.
3. At 1440 wide, transcript and notes fill the content width with chat open and closed; no empty
   gutter beside the drawer.
4. At 390 wide, Transcript and Notes are tabs, Start or the timer docks at the bottom, chat opens
   from the top bar.
5. The docked chat answers a question about the open meeting with timestamp links that scroll the
   transcript.
6. Stop writes a summary when the setting is on, and does not when off.
7. A stale or missing notice acknowledgement is asked once, then Start proceeds.
8. Unlink in Settings stops the Mac from starting a capture; Start then explains and offers Run
   setup again.
9. The still-recording dot and top-bar timer appear on other pages and clear on stop.
10. Opening chat on a meeting page with notes but no transcript answers about the notes.
11. Notes stay visible and editable when Start is pressed.
12. No screen says "draft"; no hardcoded "Unavailable" status remains.
13. Capture-mode radios render as normal radios in setup and settings, light and dark.
14. `pnpm check:ui-classes` is clean; no text below 11px; spacing minimums hold at both widths.
15. Live-path proof on a dev instance with a real linked Mac, recorded on the PR. No intercepted
    or faked data. Summary proof needs a summary-capable API-key model on that instance.

## Open decisions for Ben

1. One-time Mac link instead of approving the device each meeting. Recommended; needs the security
   review above.
2. Recording notice asked once instead of per meeting. Recommended; reversible by asking again on a
   policy version change.
3. Summary writes automatically on stop, on by default. Recommended; switch in Settings.

## Out of scope

Calendar-driven starts, auto-join bots, speaker identity, Windows capture, sharing.
