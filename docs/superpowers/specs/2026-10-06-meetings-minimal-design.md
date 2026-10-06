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

Read from `packages/meetings/src/web/` on PR 3056, branch `feat/2981-native-meeting-capture`, head
`515e1d39e`. The per-meeting "Prepare this meeting" and "Approve this device" steps are gone there;
the Mac link and its recording permission are already one-time.

Once, before any meeting:

- Link Trail Marker in Settings, Profile. Linking carries the one-time recording permission
  ("Enable meeting recording"); a Mac linked before that asks for it there once.

Per meeting:

1. "01 New meeting": optional title, then "Your recording sources" on the same screen.
2. Choose the Recording device (a connected Mac), the Capture mode radios, the Microphone, and the
   Selected app when that mode is chosen. The last successful Start prefills these from the saved
   `rememberedSource`; Change reopens them.
3. Start meeting. One click creates the meeting and starts the Mac recording. Trail Marker asks
   nothing; its menu bar item shows "● Meeting". Create draft makes the meeting without recording.
4. Stop and review.

The Mac side is already one click. What remains per meeting is the set of source pickers on the
New meeting and meeting screens.

There is no recording notice step at this head. The server no longer checks an acknowledgement on
Start (see Recording notice); that regression is being fixed on PR 3056 before this redesign builds
on it.

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
   - Link Trail Marker to this account once. The same browser approval grants the one-time
     recording permission (PR 3056 already pairs both); setup does not ask for either again.
   - Status row: device name, app version, Linked, last contact.
   - Already linked in Settings, Profile: setup shows the row as done and skips the step.
   - Unlink lives in Settings, Meetings and in Trail Marker (Security, R1 and R2).
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

"Today" is PR 3056 head `515e1d39e`.

| Today                                                              | Goes to                                             |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| Masthead hero and "View meeting history" button                    | Removed; the list is the history (`/meetings`)      |
| "Your recording sources" block on New meeting and the meeting page | One-time setup                                      |
| Capture-mode radio cards                                           | Settings, Meetings: Listen to                       |
| Recording device select, Change                                    | One-time setup: Your Mac; Settings, Meetings        |
| Microphone and Selected app selects                                | Settings, Meetings                                  |
| Per-start notice (being restored on PR 3056)                       | One-time recording notice                           |
| Retry capture command, Refresh capture status                      | One inline problem message with one fix             |
| Summary template select, Generate summary                          | Summary writes on stop; Rewrite summary in the menu |
| Generate new version, Compare with latest, Edit this version       | Menu: Earlier versions; edit inside the Summary tab |
| Save notes button                                                  | Autosave with "Saved"                               |
| Any bespoke chat panel                                             | The normal docked chat drawer                       |

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

`packages/shared/src/meeting-preferences-api.ts` at PR 3056 head already holds
`defaultCaptureMode` and `rememberedSource` (`deviceId`, `microphoneId`, optional `applicationId`,
`mode`), written after each successful Start. Setup and Settings, Meetings write the same
`rememberedSource`; Start stops rewriting it. The contract grows to:

| Field                   | Type                                        | Default                      |
| ----------------------- | ------------------------------------------- | ---------------------------- |
| `defaultCaptureMode`    | existing enum or null                       | `computer-audio` after setup |
| `rememberedSource`      | existing object or null                     | set by setup                 |
| `summarizeOnStop`       | boolean                                     | true                         |
| `summaryTemplateId`     | existing template id                        | general meeting              |
| `noticeAcknowledgement` | `{ policyVersion, acknowledgedAt }` or null | null                         |
| `setupCompletedAt`      | timestamp or null                           | null                         |

Existing rows migrate with the new fields at their defaults and `setupCompletedAt` null, so current
users see setup once. Module SQL lives in `packages/meetings/sql/`; add a new migration file.

### Recording notice

At PR 3056 head `515e1d39e`, `POST /api/meetings/records/:id/capture/start` takes no notice
acknowledgement and the server checks none; the per-start check in `capture-domain.ts` was lost
when the one-time recording permission landed. That regression is being fixed on PR 3056 directly,
restoring a server-checked acknowledgement on every Start, before this redesign builds on it.

Change in this redesign: the client stops sending a per-start acknowledgement. The server reads the
stored `noticeAcknowledgement` and binds its policy version to the grant, as the original spec
requires ("Start binds ... notice acknowledgement"). If it is missing or older than the current
notice, Start returns a prerequisite error and the page asks once, then starts (Security, R8).

### Start

- The user always clicks Start. Nothing records on New meeting, on linking or on opening the page.
- Already built at PR 3056 head: one browser request starts the linked Mac with no click on the
  Mac, through the one-time recording permission and the per-meeting grant.
- Still to build:
  - The meeting page drops the source pickers. Start sends no selection; the server reads
    `rememberedSource`, checks it against the connection's latest inventory, and fails with a
    prerequisite error rather than substitute a source (R13).
  - Stored notice binding (R8).
  - Red dot on the Mac's menu bar item while recording (R6).
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

### Link design sign-off

Reviewed 2026-10-06 against PR 3056, branch `feat/2981-native-meeting-capture`, head `af5082279`;
rechecked at `515e1d39e`.
Design review only; no code was run.

#### 0. Baseline

- Commit `d15ce4506` replaced per-meeting device approval with a one-time recording capability,
  and `packages/meetings/sql/0288_meeting_recording_connections.sql` revokes every legacy
  per-meeting grant. The Mac needs no "Prepare this meeting" click.
- PR 3056 head is now `515e1d39e`, a merge of main with no meetings, auth, shared capture or
  Trail Marker changes since `af5082279`. Everything below holds at both.
- Most of the proposed link is therefore built. This sign-off covers that model plus the controls
  in 4. The brief's flow sections now describe this head.
- Regression. At this head, `POST /api/meetings/records/:id/capture/start` takes no notice
  acknowledgement, the server checks none, and the web UI shows no notice. The per-start check in
  `capture-domain.ts` from `28a5a6beb` is gone. It is being restored on PR 3056 before the redesign
  builds on it; R8 then moves it to the stored, once-asked acknowledgement. Either way it is a
  blocker, not a tidy-up.

#### 1. Current model at `515e1d39e`

| Layer                | Secret                                                     | Mac storage                                                                                           | Server storage                                                                                      | Lifetime                                                                      | Revoke                                                                                                               |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Device link          | `tm1_` + 32 random bytes, bearer                           | Keychain generic password, service `com.moss.trailmarker`, `AfterFirstUnlockThisDeviceOnly`           | sha256 in `app.companion_devices.credential_hash`; only `jarvis_auth_runtime` has a grant           | 90 d inactivity, slid on every authenticated call; 365 d absolute             | Delete the row: Mac sign-out (`/api/companion/logout`), browser Sessions revoke, sign out everywhere, account delete |
| Recording capability | 43-char random proof, header `x-moss-recording-proof`      | Keychain service `com.moss.trailmarker.meeting-recording`, keyed by instance origin, this-device-only | sha256 in `app.companion_recording_capabilities.proof_hash` with `revision`; auth-runtime only      | No own expiry; bounded by the device row                                      | `POST /api/companion/recording-capability/revoke` bumps `revision` (API only, no button); device delete cascades     |
| Recorder connection  | Random `connectionId` and verifier per app launch          | Memory only (`MeetingRecordingConnection.swift`)                                                      | Verifier sha256 in `app.meeting_capture_connections`, owner RLS                                     | 30 s lease from last register; one row per owner and device                   | A new `connectionId` revokes every non-complete grant on that device                                                 |
| Per-meeting grant    | `mm1_<owner>.<grant>.<secret>`, minted by the Mac at claim | Memory only; no disk write in `Meetings/`                                                             | sha256 in `app.meeting_capture_grants.credential_hash`, owner RLS; worker export columns exclude it | Claim 60 s; lease 30 s; `min(now + 2 h, browser session, device, connection)` | Grant `revoked`; any failed live check on the next native call                                                       |

- Capability approval needs a live cookie session. It happens once, inside pairing
  (`recording_proof_hash` on `app.companion_pair_attempts`, `companion-pairing.ts`) or through
  attempt and decide (`packages/auth/src/recording-capabilities.ts`).
- Scope separation. `tm1_` alone reaches companion routes only. Recording routes need `tm1_` plus
  the proof. Capture status, audio and control need `mm1_`. Native routes reject any cookie;
  browser routes reject any `Authorization` header and require a trusted `Origin` on mutation.
- Start (`capture-connection-service.ts`) checks the cookie session, that the actor owns the device,
  a live connection at the expected revision, and the capability revision. It writes the grant bound
  to that browser `session_id`, the capability revision and the connection verifier.
- Every status, audio and control call re-runs `liveBinding` (`capture-service.ts`). It checks the
  starting browser session, the device row and the capability revision.
- Transport is a Mac long-poll. Trail Marker re-registers every 10 s and calls
  `POST /api/meetings/capture/commands` with `waitMs` 10 000 (server cap 20 000). Start wakes the
  waiter. Nothing connects in to the Mac, and nothing is pushed.
- The Mac shows `MeetingCaptureStatusItem`, a menu bar item "● Meeting" with Pause and Stop, in
  every phase except unprepared and stopped. A remote Start raises no notification and no window.
- On 401 or 403 the Mac terminates capture (`MeetingCaptureHost.swift`, `poll`).
- Logs. `apps/api/src/recording-logger-options.ts` redacts the proof header, `verifier`,
  `pcmBase64` and `recordingProof`. The Fastify 5.8.5 default request serializer logs method, URL,
  host and peer address, never headers, so `tm1_` and `mm1_` do not reach request logs. Not
  verified for every handler-level log call.
- Capture enqueues no pg-boss job. Worker export grants on capture tables exclude verifier hash,
  credential hash, session id and start keys (`0284`, `0288`).

#### 2. Proposed link

- No new credential type. After linking, the Mac holds `tm1_` and the recording proof, both in the
  Keychain, this-device-only. The server holds sha256 digests only, readable by the auth runtime
  role only.
- Linking requests the recording capability in the same browser approval. Pairing already carries
  `recording_proof_hash` for this.
- Start is one browser request. The server fills the selection from saved preferences, validates it
  against the connection's latest inventory, and creates the grant. The Mac's long-poll returns the
  command, the Mac claims it with its in-memory verifier and a fresh `mm1_` hash, and capture starts.
  The Mac asks no question.
- Lifetime: device 90 d inactivity and 365 d absolute, unchanged. Recording capability adds a 90 d
  re-confirmation (R9).

#### 3. Threats

| Threat                                      | What it can do                                                                                                                                                                                                                                                                                                         | Answer                                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen `tm1_` and proof, copied off the Mac | From anywhere, register as that Mac's recorder, take the next Start and upload chosen audio into that meeting, or kill a live recording by registering a new connection. Cannot read transcripts, notes or other meetings; the command carries ids and the selection only. Cannot make the real Mac record.            | Unlink revokes both at once (R1, R2). Settings shows last contact. Code execution on the Mac is out of scope; it can open the microphone without Moss. Residual: no hardware-bound key. A Secure Enclave key is a follow-up, not a blocker. |
| Mac left signed in, or sold                 | Polling slides the 90 d window, so the link lives up to 365 d. The owner's next Start records whatever room that Mac is in.                                                                                                                                                                                            | Unlink from Settings or the Mac (R1, R2). No capability lapse (R9, Ben 2026-10-06). Settings lists each Mac with last contact.                                                                                                              |
| Stolen browser session presses Start        | Records the room of any linked, connected Mac for up to 2 h. Today the only signs are the menu bar item and the OS microphone indicator.                                                                                                                                                                               | Grant is bound to that session; revoking it stops capture (R5). Red dot on the menu bar item while recording (R6). Per-account Start limit (R10).                                                                                           |
| Second user on the same Moss install        | None found. Device rows are per user and auth-runtime only. Start asserts the actor owns the device. Connections, grants and receipts are owner RLS with no admin bypass. `mm1_` names its owner, and RLS then hides any other owner's grant.                                                                          | Holds. Test it (T6).                                                                                                                                                                                                                        |
| Replay of an old Start                      | None found. `requestKey` is unique per owner and fingerprinted over meeting, session and body. A cancellation fence persists. Claim needs the current connection's in-memory verifier within 60 s. One active grant per meeting and per connection. A meeting with captured audio or a transcript refuses a new Start. | Holds. Test it (T7).                                                                                                                                                                                                                        |
| Mac records with no visible sign            | The menu bar item can be hidden by menu bar overflow behind the camera notch or by a menu bar manager. The OS microphone indicator is macOS behaviour, not app code, and is not verified here.                                                                                                                         | Accepted by Ben 2026-10-06: R6 is a red dot on the menu bar item only, no notification or panel.                                                                                                                                            |

#### 4. Required controls

- R1 Unlink from Moss. Settings, Meetings, Unlink deletes the `app.companion_devices` row in one
  transaction. The next native call with that Mac's `tm1_`, proof or `mm1_` returns 401 or 403.
  No audio chunk received after the commit is stored.
- R2 Unlink from the Mac. Trail Marker calls `/api/companion/logout`, then deletes the `tm1_` and
  proof Keychain items. If the server is unreachable it keeps retrying and says "Not unlinked yet";
  it never reports unlinked before the server confirms. Server effect equals R1.
- R3 Live session on unlink. Within one lease (30 s) the server marks the grant revoked, the Mac
  stops capture and drops unsent audio, and the meeting page says the recording stopped because the
  Mac was unlinked. Audio stored before the unlink stays in the meeting. Applies to capability
  revoke and device delete alike. Grants have no foreign key to `app.companion_devices`, so the
  meetings module must settle them on a failed live check; auth must not write meetings tables.
- R4 Per-meeting lease unchanged. One grant per Start; claim within 60 s; lease 30 s; hard cap
  2 h; bounded by browser session, device and connection expiry. Every status, audio and control
  call re-runs `liveBinding`.
- R5 Session binding. The grant stays bound to the starting browser session. Signing that session
  out, or "sign out everywhere else", stops capture within 30 s.
- R6 Visible on the Mac. While recording, the Trail Marker menu bar item shows a red dot. It
  posts no notification and shows no panel. Ben ruled this on 2026-10-06. The menu bar item and the
  OS microphone indicator are the only on-Mac signs, so a hidden menu bar item (notch overflow or a
  menu bar manager) leaves only the OS indicator.
- R7 No on-Mac confirmation. A confirm click would undo the one-click Start Ben asked for, and it
  does not stop the stolen-session case once a person is at the Mac anyway. Visibility (R6) plus
  revoke (R1, R5) is the control.
- R8 Notice binding. Start fails with a prerequisite error unless the stored acknowledgement's
  `policyVersion` equals the current notice version. The grant records the bound version. The
  client no longer sends `noticeAcknowledged`.
- R9 No capability lapse. The recording capability has no expiry of its own; Ben ruled this on
  2026-10-06. It ends only on Unlink, revoke or device expiry. Device expiry stays 90 d inactivity
  and 365 d absolute.
- R10 Rate limits. Keep the existing per-IP limits (Start 60/min, claim 60/min, connection and
  commands 120/min, capability decide and revoke 20/min). Add a per-account limit on Start of
  10/min and 60/h, returning 429 with `Retry-After`.
- R11 Secrets never escape. `tm1_`, the proof, the verifier and `mm1_` never reach logs, pg-boss
  payloads, user exports, AI prompts or frontend responses. Add `req.headers.authorization` to the
  recording redact paths as defence in depth.
- R12 Revoke surfaces. Settings, Meetings has Unlink (R1) and a recording-only switch-off that
  calls the existing capability revoke. Trail Marker has Unlink (R2).
- R13 Saved defaults only. Start never captures a source outside the saved selection. If a saved
  microphone or app is missing from the current inventory, Start fails with a prerequisite error;
  it does not substitute a source silently.

#### 5. Tests

Integration tests run against the real auth services, not the `reapprove` fake in
`tests/integration/meeting-capture.test.ts`. "Fail" means the test must be seen failing with the
named protection removed, recorded on the build PR.

| #   | Test                                                                                                       | Level       | Must fail when removed                  |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------- |
| T1  | Unlink from Moss mid-recording: next status and audio return 401/403; no chunk stored after commit         | Integration | Device check in `liveBinding`           |
| T2  | Mac logout mid-recording: same result as T1                                                                | Integration | Device check in `liveBinding`           |
| T3  | Capability revoke mid-recording: grant revoked within one lease; audio refused                             | Integration | Capability revision check               |
| T4  | Starting browser session signed out: capture stops; audio refused                                          | Integration | Session check in `liveBinding`          |
| T5  | Claim after 60 s, call after 30 s lease, call after 2 h cap: all refused                                   | Integration | Each expiry comparison                  |
| T6  | User B cannot list, Start, claim or send audio for user A's Mac or grant; admin cannot either              | Integration | Device owner check in Start; RLS policy |
| T7  | Same `requestKey` with a changed body is 409; old Start after a new connection cannot be claimed           | Integration | Fingerprint check; verifier check       |
| T8  | Start with a missing or stale notice acknowledgement returns the prerequisite error                        | Integration | Notice version check                    |
| T9  | Capability stays valid with no Start for over 90 d; Unlink and revoke still end it                         | Integration | Revoke path                             |
| T10 | Eleventh Start in a minute from one account returns 429                                                    | Integration | Per-account limiter                     |
| T11 | Full start, record, stop: captured log stream and user export contain no `tm1_`, `mm1_`, proof or verifier | Integration | Redact path; export column grant        |
| T12 | The menu bar item shows the red dot from accepted Start until Stop, and clears it on every stop path       | Mac unit    | Red dot state                           |
| T13 | Mac Unlink calls logout before deleting Keychain items, and keeps them while logout fails                  | Mac unit    | Ordering                                |
| T14 | Live path on a real linked Mac: Start shows the red dot; Unlink in Settings stops capture within 30 s      | Live, on PR | Not applicable                          |

#### 6. Verdict

Signed off with the controls above. Every control is required before the build PR merges; R1, R3,
R5, R6 and R8 change the trust model most and are the first a reviewer checks.

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

## Decisions

Decided by Ben, 2026-10-06:

1. One-time Mac link instead of approving the device each meeting, with the controls in Link design
   sign-off.
2. Recording notice asked once, then asked again only when the notice's policy version changes.
3. Summary writes automatically on stop, on by default, with a switch in Settings, Meetings.
4. The user always clicks Start. Nothing records on linking, on New meeting or on opening a
   meeting.

Ben ruled on the security-review defaults on 2026-10-06:

5. While recording, the Mac's menu bar item shows a red dot. No notification and no panel (R6).
6. The recording permission does not lapse (R9).
7. Binding the link to the Mac's hardware (Secure Enclave key) is a later follow-up, not part of
   this build.

## Out of scope

Calendar-driven starts, auto-join bots, speaker identity, Windows capture, sharing.
