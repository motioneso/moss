# Meetings: minimal meeting screen

Status: approved direction; implementation and live verification tracked in #2981.
Implementation PRs: #3056 (capture), #3079 (workspace), #3082 (Mac controls).
Design PR: #3077. Owner-approved screen sources: #3087 and merged #3089.

## Approved source

Ben approved the screens in #3087 and #3089 in owner chat on **2026-10-06** (owner-local date),
and reaffirmed that approval when requesting the fixes to [review 6034226446](https://github.com/motioneso/moss/pull/3077#issuecomment-6034226446).
This records owner-chat approval, not a GitHub review. #3087 remains a design-source PR;
#3089 is merged. Neither status is a prerequisite for opening this spec's self-contained screens.

The four local HTML states are the source of truth for linking, readiness, recording and Settings:

- [Not linked](meetings-minimal/01-not-linked.html)
- [Ready](meetings-minimal/02-ready.html)
- [Recording](meetings-minimal/03-recording.html)
- [Settings](meetings-minimal/04-settings.html)

Open the [local index](meetings-minimal/index.html). These carry #3087 commit
`5bca8dfb88cc6f436f599345fdf66e0150b89fac`, with the owner's corrections below and the
automatic-summary switch retained from #3079. The [source record](meetings-minimal/README.md)
lists the exact provenance and changes.

The same folder carries #3089's approved [record-backed card](meetings-minimal/approval-card/02-change-settings.html),
[approved result](meetings-minimal/approval-card/04-approved.html) and
[declined result](meetings-minimal/approval-card/05-declined.html) as visual references for ordinary
approval presentation. They are unchanged synthetic examples, not an additional Meetings screen
or a second recording approval. The existing browser linking flow remains the sole initial
approval surface; do not transplant a settings-change card into it.

The [earlier critique](../mockups/meetings-minimal/critique.md) is explicitly historical and
does not authorize its old setup controls.

## Direction

A meeting is New meeting, then Start recording. Linking, opening a page, changing a setting and
creating a meeting never begin capture. The page is a transcript and a place for notes, using the
available width. Moss chat stays the ordinary docked drawer, scoped to the open meeting.

No source question or separate linking wizard precedes a meeting. The native app's existing
connect-in-browser flow owns linking. Its one initial linking approval also grants the recording
capability for that exact Mac. There is no separate Approve recording / Deny recording card,
acknowledgement, recording disclosure paragraph or reminder after linking. Authentication and
operating-system permissions remain required, and each recording still needs an explicit Start.

## Four states

### Not linked

Show the Meetings heading and the shared empty state:

- Title: “Link your Mac”
- Description: “Open Trail Marker and follow its linking instructions.”
- Button: “Download app”

Download app is an inert button with no link or release URL. There is no signed release yet.
Do not show the Moss address or a copy button in this browser state. This is the final approved
choice; keep the not-linked screen exactly as the mockup. The native app’s existing first-screen
Moss address input is outside this change and remains available for its normal linking flow.

A temporarily disconnected linked Mac is not an unlinked Mac. Keep existing meetings readable and
show a truthful connection problem rather than asking the user to link again unnecessarily.

### Ready

New meeting opens the workspace without recording. Show “New meeting”, a truthful Ready badge,
“Start recording”, and the connected Mac's name. Transcript and Notes occupy the two columns.
The empty transcript says “Start when you’re ready.”; Notes uses “Add a note…”.

The recording default is Microphone + system audio. Resolve the Mac's actual OS-default microphone
from its inventory, even when several microphones are present. A single-microphone inventory may
serve an older client without default metadata. Missing or ambiguous defaults fail closed with
useful connection guidance. Never treat alphabetical inventory order as a default.

For a fresh account, choose the sole eligible linked, connected Mac. Ambiguous multiple-Mac state
must not silently select a different room. No setup-completion flag gates Start.

### Recording

Keep transcript and notes side by side. Show Recording only for a confirmed live recording state;
“Listening…” describes actual capture, not an unconfirmed Start request. Notes remain mounted,
autosave, retain conflict recovery and survive navigation.

The compact pill illustrated over the browser scene is Trail Marker's floating native overlay.
It is not a second browser level meter or a new audio-level transport. Existing browser controls
remain usable for capture recovery and safe Pause/Resume/Stop.

The native pill is approximately 250 × 80 points, with a **pure white surface in every appearance,
including dark mode**, a light border, pill radius and soft floating shadow. Its surface must not
follow the app's light/dark background token. It contains:

- A small red **three-bar level meter**, approximately 32 × 24 points; never a zigzag waveform
- A 54-point circular Pause control with a grey ring and grey pause icon
- A 54-point solid semantic-red Stop control with a filled white square

There is no visible status text, meeting name, elapsed timer or close button. Accessible names,
status descriptions and tooltips remain. The three bars reflect actual captured audio levels;
silence, absent or stale audio, Pause and terminal states flatten all three bars. No decorative
activity animation. The static mockup illustrates the shape, not a live level signal.

Keep the existing native Pause and Stop authority. The paused pill’s play button resumes the
current recording directly after an explicit click. Resume retains the same paused, claimed grant, exact
audio sources, owner, device, session, capability and expiry. It cannot create an initial Start,
change sources or revive ended authority. A newer Pause or Stop cancels a queued Resume; a known
rejection requires a new click. An uncertain transport result may retry only the same request
identity within the existing bounds, without a replacement grant or extended expiry. Hardware and
uploads remain paused until authoritative server acknowledgment and normal status application.
The browser’s Resume remains available. The pill remains draggable, nonactivating and visible
across Spaces and full-screen apps.
The menu-bar red dot stays visible from Start through Pause until Stop. No system notification.

### Settings

At `/settings?section=modules&module=meetings`, show only:

1. Linked Mac name and link status
2. Audio source: Microphone + system audio, or Microphone only
3. Summarize automatically after Stop (on by default)
4. Unlink Mac

Audio changes save directly with explicit pending/error feedback. No Finish setup, Run setup again,
source wizard, microphone picker or application picker appears here. The summary switch saves
immediately with pending/error feedback; turning it off leaves manual Rewrite summary available.

Existing saved selected-app choices are compatibility data. Preserve their exact device,
microphone and app scope until the owner explicitly changes Audio source. Display a truthful
non-selectable current legacy value if needed; do not label it system audio or silently broaden it.
Changing to one of the two approved modes is the explicit scope change.

Unlink retains confirmation, exact device identity checks, repeated-click protection and stale
response fencing. Device capability revocation continues to work through its existing authorized
surfaces and APIs; simplifying this Settings screen does not remove that protection.

## Workspace and history

The four states do not delete existing history or post-meeting features.

- The Meetings list retains search, week grouping, title, short summary and recorded duration.
- Titles edit inline and automatic summaries may rename an untouched title. An existing
  untitled meeting is labelled Untitled meeting in its page heading, list and chat chip.
- Transcript labels, timestamps, source attribution and evidence navigation remain.
- Notes autosave with conflict recovery; deleting a meeting retains confirmation.
- After Stop, Summary remains beside Notes; task creation requires the owner's review.
- Rare actions stay in the meeting menu: transcript search, rewrite summary, earlier versions,
  Save to vault, Copy as Markdown and Delete meeting.
- Capture gaps remain inline transcript markers; delayed transcription is distinct from recording.
- This feature introduces automatic-summary preferences; they were not present on the base branch.
  Automatic summaries default to on and send finalized transcript and notes to the configured
  summary model after Stop. Settings → Meetings exposes Summarize automatically after Stop;
  switching it off saves `summarizeOnStop=false` without resetting other preferences.
  Only the automatic path renames an untouched Untitled meeting; manual Rewrite preserves its title.
- The ordinary chat drawer can use the open meeting's transcript and notes, including notes-only
  meetings. Its context chip is removable; timestamp citations scroll to the transcript. Failed
  questions stay above their error in the open chat. Access checks remain live; title refreshes
  do not refetch the full meeting record on every access poll.
- Preserve useful persistent recording navigation and recovery controls away from the meeting.

Use `@moss/ui` components and semantic Moss tokens. Headings use Archivo; no serif. Module CSS owns
layout only. Keep minimum spacing and responsive behavior, with transcript/notes filling the
available width and no wasted gutter when chat is open.

## Capture contracts and defaults

Start is an explicit owner-session request. The server resolves a fresh default or an existing
saved selection against current native inventory, then checks the current device, connection,
recording capability and processing availability under the existing locks.

`defaultCaptureMode` defaults to `computer-audio`. `rememberedSource` retains exact saved identities
for compatibility. Settings may update the mode without requiring a source-selection form.
Neither a setup timestamp nor a setup-completion write is required.

The optional inventory `defaultMicrophoneId` is the UID of the OS default input in the advertised
microphone set. Unknown, duplicate or excluded identities are not eligible. Read this property
without opening a capture device or asking for permissions. The server's strict schema accepts
the optional field before a new native sender uses it.

Saved exact sources are never broadened implicitly. A missing saved microphone or selected app
fails with a source-unavailable error. Resume stays bound to the grant's Mac, its current generation
and current inventory; it cannot silently move to another Mac.

Source choices change only in Meetings Settings. A failed permission or unavailable system-audio
source does not silently fall back to microphone-only capture. The user can explicitly choose
that mode in Settings.

## Authentication and safety controls

These requirements survive the simpler screens and must be verified against implementation.
Existing code descriptions alone are not live security proof.

- Device linking uses the app's current browser approval and Keychain-backed credentials.
  The same initial owner approval grants linking and recording capability for that exact Mac;
  linking must not report recording-ready until both are established. No second approval card or
  disclosure paragraph follows. No new credential type or browser-to-Mac inbound connection is
  introduced.
- The server may store and enforce the recording capability separately from ordinary device
  authority. A device token alone remains insufficient for capture. Keep capability revision,
  owner/device binding, session checks, exact source scope, expiry and revocation enforcement.
- Previously linked Macs without authoritative prior recording consent must explicitly relink
  through the existing browser approval. Never silently upgrade an ordinary device token into
  recording authority. An existing authoritative recording grant may be preserved only within its
  original owner, device and scope; no migration may broaden it or replace evidence of consent
  with an inferred preference. Until eligible, show a concise relink recovery action, not a new
  Approve recording card. Retired attempt/decide mutations retain authentication and origin checks
  and return 410 to authenticated callers; they cannot issue recording authority. Read-only recovery
  may restore only an exact previously approved candidate still bound to live authority.
- Start creates a per-meeting grant bound to the starting browser session, exact device,
  connection and recording capability. Opening, linking and permission grants never issue Start.
- Preserve claim deadline 60 seconds, capture lease 30 seconds and hard session cap 2 hours,
  additionally bounded by browser session, device and connection expiry.
- Device expiry stays 90 days inactivity and 365 days absolute. Recording capability has no
  independent expiry; Unlink, revoke and device expiry end it.
- Native status, audio and control requests continue current-credential and live-binding checks.
  Another owner, including an administrator, cannot access the owner's private capture data.
- A new recorder connection invalidates superseded capture authority. Request keys, fingerprints,
  cancellation fences and grant occupancy prevent replay and duplicate Starts.
- Keep per-IP limits and the per-account Start limit of 10 per minute and 60 per hour, including
  Retry-After behavior. Pause, Stop and Start cancellation remain available under failure.
- Keep the existing bounded audio mailbox, transient retry identity, source scope validation,
  cutoff mapping and finalization. Never repurpose a Stop clock as a freshness clock.
- A revoked device, capability or starting browser session stops capture and rejects new audio.
  Previously accepted transcript data remains subject to the ordinary meeting lifecycle.
- Native Unlink stops capture and drops unsent audio first. Credentials remain until the server
  confirms logout; failed or lost responses do not falsely report success. Pending Unlink survives
  restart and retries through the existing idempotent logout flow.
- Secrets, recording proofs, verifier hashes and bearer credentials never belong in browser
  responses, exports, AI prompts or job payloads. Preserve restricted grants and log redaction;
  follow values through handlers before claiming complete coverage.
- Core Audio system-audio permission is checked by actual use at explicit Start. The Screen
  Recording settings row must describe current screen/system-audio uses without pretending its
  screenshot preflight proves Core Audio permission. Permission refresh never starts capture.

## Threats that remain explicit

A stolen device token plus recording proof can impersonate that recorder's connection. It cannot
be treated as harmless simply because linking is one-time. Revocation, owner checks, bounded grants
and credential storage remain essential. Hardware-bound keys are a separate future change.

A stolen browser session can request capture on a linked Mac. Session revocation, the visible
native pill, red dot, OS indicators and capture limits mitigate this risk; the UI simplification
does not claim to eliminate it.

A linked Mac left elsewhere must not be silently substituted for a missing saved Mac. Ambiguity
or missing sources must stop the new Start, preserving the explicit scope of an existing selection.

## Migration and stack rules

Keep published branch history and push only fast-forward updates. Do not rebase or force-push.

Main already owns migration numbers 0289, 0291, 0293 and 0294. Check both main and other active PR
claims before allocating any number. The runner checks each filename/version and checksum, and
applies a missing migration even if a higher number was previously applied; test that behavior.
Do not renumber the existing lower meetings migrations unless executable evidence requires it.
The owner confirmed the abandoned 0290 file was never merged; delete it outright rather than
adding a schema-retirement migration. No production database action is part of this work.

## App map and documentation

Keep module manifest navigation, Settings, features, errors and remediations truthful in the same
PR as the implementation. Update the core Profile/recording descriptions where the reduced
Settings screen or native controls change them. Linking points to the native app's existing flow.
Remove obsolete setup prerequisites and preference completion claims.

Update the native setup copy, current README and implementation plans. Preserve authentication
and permission boundaries even when adjacent explanatory copy becomes shorter.

## Verification

1. Fresh account plus linked Mac reaches ready without source questions. Multiple microphones use
   the advertised OS default; reorder/duplicate labels cannot change selection.
2. An unlinked account sees only the approved link message and inert download action. No address
   or copy field appears. Existing meetings remain readable.
3. Creating/opening/linking does not record. One explicit Start does. Repeated clicks, interrupted
   navigation, late replies, account changes and denied access preserve existing fences.
   One initial linking approval grants the exact Mac's recording capability without a second
   card or disclosure paragraph. Legacy linked devices without authoritative consent fail closed
   with explicit relink recovery; existing eligible grants are not silently widened.
4. Settings includes its four controls. Audio and automatic-summary saves handle failure, retry,
   navigation, stale replies and account-reset fencing.
   Legacy selected-app scope is preserved until an explicit change.
5. Pause/Resume/Stop, cancellation, superseded generations, missing sources and permissions are
   covered independently. UI simplification does not bypass a server guard.
6. Native actual audio moves exactly three red bars. Silence, absent/stale samples, Pause and every
   terminal path flatten all bars. Geometry is 250 × 80, controls are 54 points, Pause has a grey
   ring, visible text is absent and the capsule stays pure white in light and dark appearances.
7. Unlink from browser and Mac, capability revoke, session logout, expiry, cross-owner access,
   grant replay and rate limits retain positive and guard-removal negative controls.
8. Catalog, export, deletion and module lifecycle tests match the new schema and API surface.
   Apply missing lower-numbered meetings migrations after the current main catalog in an isolated DB.
9. Run root and test TypeScript checks, scoped lint, formatting, file-size, design token, UI-class,
   catalogue, app-map and migration-number checks. Database suites use the verify-gate skill only.
10. Hosted macOS CI compiles and exercises XCTest; hosted isolated database CI verifies migrations
    when the cloud workspace lacks Docker. Identify every unrun stage explicitly.
11. Live acceptance uses a real dev instance and linked Mac: Start, real audio, silence,
    Pause/Resume/Stop and Unlink. Record bounded DOM/network/log assertions on the PR. No intercepted
    responses, fabricated data or screenshots as proof. Without this, status is code-complete,
    unverified; do not merge or mark the feature Done.

## Release note

Design PR: Category N/A. Implementation PRs: Category Changed, title “Simpler meetings”. Suggested
plain-English description: “Start a meeting with one click and change recording audio in Settings.”

## Out of scope

Calendar-driven starts, auto-join bots, speaker identity, Windows capture, sharing, a new linking
wizard, a signed app release, a new browser audio-level channel and hardware-bound credentials.
