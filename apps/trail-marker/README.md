# Trail Marker

The native macOS companion for Moss. Menu-bar only app; see
`docs/specs/Trail Marker/trail-marker-design-guide/DESIGN_GUIDE.md` for the design authority and
`docs/superpowers/specs/2026-09-20-trail-marker-mac-companion.md` for the spec.

This app lives outside the pnpm workspace (`apps/trail-marker/` has no `package.json`), because its
tests need a Mac and its CI job is a separate `macos-15` GitHub Actions runner.

## Requirements

- macOS 14 or later.
- Xcode (full install, not just Command Line Tools).
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.

## Building locally

```sh
cd apps/trail-marker
xcodegen generate
xcodebuild test -scheme TrailMarker -destination 'platform=macOS'
```

`xcodegen generate` produces `TrailMarker.xcodeproj`, which is not committed — regenerate it after
pulling changes to `project.yml`.

## Running an unsigned local build

Until Apple Developer enrollment happens (task 15 of the plan), builds are unsigned and
un-notarized. Opening one downloaded or copied from another Mac will show Gatekeeper's "can't be
opened" warning; a build produced by `xcodebuild` on the same Mac that runs it does not hit that
warning. There is no public release yet — this is a local developer build only.

## Clearing local state between test runs

Trail Marker keeps these outside the app bundle, so quitting or reinstalling the app does not
reset them:

- **Keychain**: the link credential and Backtrack buffer key use `com.moss.trailmarker`.
  Meeting recording proof and pending approval proof use separate recording namespaces, scoped
  to the instance origin and device. For a deliberate first-run reset, use Keychain Access
  (search "trailmarker") to remove the development identity's matching items. Deleting only the
  base service does not remove its separate recording proofs. Unlink clears the linked identity’s recording proofs only after Moss confirms server logout.
- **Preferences**: `UserDefaults` under the app's bundle identifier. Reset with
  `defaults delete com.moss.trailmarker`.
- **Backtrack's offline buffer**: `~/Library/Application Support/com.moss.trailmarker/Backtrack/buffer.bin`,
  text not yet accepted by Moss, encrypted with the Keychain key above. Logging out deletes both.

Run all three before re-testing first-run linking from a clean state.

## Backtrack in Release builds

Backtrack is in Release builds from phase 2b. It appears in Settings only once the linked Moss says
it stores Backtrack (an admin turns on the `backtrack.storage` instance switch); Debug builds always
show it and also keep the last 200 segments in memory for Show text…. Text goes to Moss about once
a minute and waits in the encrypted buffer while Moss can't be reached, for up to a day. To check a
Release build contains the uploader and none of the Debug preview:

```sh
scripts/check-release-backtrack.sh "<DerivedData>/Build/Products/Release/Trail Marker.app/Contents/MacOS/Trail Marker"
```

## Stable signing on your own Mac (optional, avoids repeated password prompts)

Without a signing certificate every rebuild is signed ad hoc with a new identity. macOS then treats
each build as a different app: it asks for your password again to read the Keychain credential, and
it forgets Accessibility and Screen Recording. To avoid that on a development Mac:

1. Create a self-signed code-signing certificate named `Trail Marker Dev` in your login keychain
   (Keychain Access: Certificate Assistant, Create a Certificate, type Code Signing), and trust it
   for code signing.
2. Create `apps/trail-marker/Local.xcconfig` (it is ignored by git) containing
   `CODE_SIGN_IDENTITY = Trail Marker Dev` and `CODE_SIGN_STYLE = Manual`.
3. Run `xcodegen generate`, rebuild, click Always Allow once when macOS asks about the Keychain,
   and grant the privacy permissions once.

Builds without that file behave exactly as before. Release builds keep hardened runtime on;
development builds turn it off because it refuses to load the debug library and Sparkle when they
are signed with a different identity.

## Backtrack performance trial (Debug only)

Build and test from `~/Jarv1s/apps/trail-marker`. The Show text… preview remembers text only in
memory; quitting or restarting the app clears that text. Run the new build only after finishing with any
history you want to consult in the current instance.

The retry checks recent screen fingerprints after switches as well as periodically, refreshes
each screen after five minutes, and pauses capture after five minutes without input. Keyboard or
mouse input resumes capture within five seconds. A window whose reads keep finding nothing new is
read less often, down to once a minute, and periodic reads wait while you type (at most 30
seconds); switching windows is never delayed. Each read first takes the window's visible text
through Accessibility, skipping password fields without reading them, and changes no setting in the
app being read. Only when that gives too little (under 100 characters, mostly buttons and menus, a
canvas app such as Figma, or a terminal such as kitty that exposes no text) does it take a picture
for on-device recognition, without language correction, at most 1600 px. This means passive reading or screen sharing without
input pauses too; include those cases when judging usefulness.

After launching the trial build and turning Backtrack on through its existing consent flow, sample
a normal working day from another terminal:

```sh
cd ~/Jarv1s/apps/trail-marker
bash scripts/backtrack-cpu-trial.sh
bash scripts/backtrack-metrics-report.sh 8h "$(pgrep -x 'Trail Marker')"
```

Pass the trial app's pid to the metrics report: unit-test runs log to the same category and would
otherwise be counted. The report includes a per-app table of Accessibility reads and recognition
passes. The CPU sample also reports `mediaanalysisd` alongside, ungated.

The CPU sample runs for about eight hours and fails above 3% mean CPU or if the process exits before
all samples are collected. The first CPU reading is discarded because it is not an interval
measurement. The metrics report estimates OCR, capture and thumbnail costs, split by trigger, using
process CPU deltas that can overlap other work. A short or idle-only run cannot pass the working-day
gate. Record the sample and whether the text answers three real "what did I see?" questions on the
PR; Phase 2 stays gated until both CPU and usefulness pass.

## Meeting recorder development path

Meeting output capture requires macOS 14.2 or later. Build locally with the Xcode instructions
above; this branch does not provide a signed distribution or Windows recorder. Preserve any local
diagnostic changes before pulling this repair; use a clean worktree to compare them with the new
source instead of replacing an existing test checkout.

Moss can run on a remote or headless server. Run Trail Marker on the **recording client Mac**,
whose microphone and app/computer audio should be captured. Moss does not need to be installed on
that Mac and never uses audio hardware attached to its server. Browser and companion connect to
the same public HTTPS origin, including its port. “Same origin” means the same remote Moss server,
not the same computer. Unencrypted HTTP is accepted only for loopback development addresses
(`localhost`, `127.0.0.1`, or `::1`). The final canonical origin must be exposed directly; capture
transport does not follow redirects or support path-prefix deployments.

Connect Trail Marker through its existing one-time flow. New clients include meeting-recording
capability in that single approval, with no separate recording approval. A linked Mac without
recording authorization, or with revoked access, must sign out under Settings → Active
sessions and explicitly relink through Trail Marker. Already-approved Macs remain linked. A saved
candidate from an older build can only recover the same already-approved proof through read-only
status; it cannot request new approval. The independent
recording proof is stored in this Mac's Keychain; the server holds its hash. Connecting or approving
does not record. Backtrack keeps its separate existing consent and retention behavior.

Link this Mac through Trail Marker, then explicitly press **Start recording** in Moss. A fresh
source choice uses the Mac's exact OS-default microphone with computer audio. Settings → Meetings
can change the audio source. The native inventory reports the default microphone's stable UID,
independently of display-name ordering; a missing or ambiguous default is never guessed among
multiple microphones. Moss remembers the stable source identities; later OS-default changes do
not retarget a saved choice. Missing or ambiguous sources require explicit selection and never
widen capture. First use may request an OS microphone/system-audio permission. If Stop,
revocation or expiry occurs while permission is pending, granting permission cannot start audio.
There is no per-meeting Prepare, approval or second Record button. Trail Marker
keeps the current browser in place rather than launching the default browser for each meeting.

This native build always sends `defaultMicrophoneId`: the exact UID or explicit `null` when
the default cannot be resolved. Only omission by older clients permits the server's legacy
single-microphone fallback. A matching Moss server must accept the nullable field; older strict
inventory schemas reject it. Screen Recording status is not a system-audio permission
preflight: meeting computer audio may still ask for access when Start opens the selected tap.

Viewing Moss from another computer controls the explicitly named recorder; it never switches to
that browser's hardware or the server's hardware. Browser-only capture is not implemented.
Transcription is configured only through AI providers in Moss.

Each accepted Start shows a small draggable pill above ordinary windows on every Space, including
alongside full-screen apps. The 222 × 32-point pure-white capsule (including dark mode) shows a compact source menu,
a red three-bar level meter, a grey-ringed round Pause button and a solid red Stop button, without visible status text, elapsed time
or meeting title during normal capture. During automatic same-source recovery it shows “Recovering audio…”; a hard interruption expands it with a persistent warning and reason, even if it was hidden. Hide is unavailable until that warning is resolved. Its far-right X otherwise only hides the
pill, as does a native window-close command. Recording continues, and the red Meeting menu retains
Pause/Stop plus **Show recording pill** to restore it. Showing a paused pill does not resume capture.
Every new accepted Start shows the pill again. Its accessibility value still describes Recording, Paused,
No audio or Reconnecting. Each 250 ms display tick flattens all three bars for silence and treats a
peak at least 500 ms old as missing input; Pause clears it immediately.
The display reads a bounded local atomic scalar per source; it does not retain extra samples, send levels or put them in logs. When both
sources are selected, it shows the maximum current source peak. Reconnecting can still display
real input during a valid capture lease. Its paused play button explicitly resumes the same paused recording through Moss. It retains the
original grant and sources, waits for authoritative status before reopening hardware, and cancels
pending Resume when a newer Pause/Stop or a known rejection wins. Initial Start remains in Moss.
No system notification or additional on-Mac recording confirmation is added.

The pill source menu lists the Mac's advertised microphones plus **None**, and a separate
**Computer audio** toggle. It changes this recording only. Both inputs off is rejected before
device shutdown or a network request, with “Select a microphone or turn on computer audio.”
Computer-only capture opens no microphone and does not request microphone permission. An active
change closes the old receivers and devices before sending its fixed source-change request. The
replacement opens only after the matching control receipt and ordinary status; its audio waits
for acknowledgment of the new recording observation. A paused change stays paused until Resume.
Network uncertainty pauses capture, bounded retries reuse the same request, and Stop takes priority.
Pause-gap metadata is split at the server's source-epoch boundary, including a source change whose
reply was lost before Stop. The old and new intervals keep their respective source identities.

The Trail Marker menu-bar mark shows a red dot from accepted Start until Stop, including Pause.
The existing meeting menu retains local Pause/Stop controls across browser navigation.
Stop or a terminal authorization, expiry or identity path clears the ordinary
recording surfaces. Failed cleanup instead retains a persistent warning with Stop available. Moss also keeps controls available while visiting History or other modules.
Pause closes inputs and starts no new audio uploads. Stop fixes the cutoff and drains only retained
pre-cutoff audio for up to 60 seconds; a new native recording waits for this bounded finalization.
Pause All, Unlink and quit close capture. A lease expiration discards unsent audio even when paused.
Cleanup failures remain visible in meeting controls and block continuation.

Mac **Unlink** uses the canonical companion logout. It stops capture and drops unsent audio before
network work, then deletes the companion credential and recording proofs only after a 204 server
response. The matching Part B server makes logout idempotent: it deletes the row matching the
saved credential’s digest, including an expired row, or confirms that no matching row remains.
A retry after a lost 204 or an earlier Settings Unlink can therefore confirm completion without
restoring recording access. Failed requests, including an unconfirmed 401, retain the credentials
and show “Not unlinked yet” with Retry Unlink and a Settings remediation. Requests time out after 15 seconds;
retry delays grow from 5 seconds to a 300-second cap. Pending unlink survives restart and permits
only logout retries, never a reconnect or new recording. If the server confirmed but Keychain
cleanup failed, restart retries only that local cleanup. The recording permission has no separate
inactivity expiry; Unlink, revoke and device expiry still end it. Hardware-bound credentials are a
future credential/server-verifier seam; this build creates no hardware key or new sign-in flow.
Reconnection and restart never issue a new Start or silently resume a paused/expired recording.

Capture tolerates ordinary host-clock jitter, unchanged format notifications and brief callback
contention. A terminal ASR failure records a gap for that chunk; it does not itself stop healthy
inputs. Transcription delay and connectivity delay are distinct from recording state. Transient
retries remain bounded by a 30-second authorization lease and transient memory: at most 60 seconds
and 2,097,152 Float32 samples (8 MiB) per track, with at most 16 retained rings (128 MiB of sample storage) process-wide, plus bounded
metadata/request buffers.
At 48 kHz the sample bound is approximately 43.7 seconds. The first applicable bound wins; exhaustion
pauses visibly. There is no audio disk spool or recovery after process exit.

Computer mode verifies native Moss process exclusion and rechecks relevant changes; unrelated app
process churn alone is not a reason to stop. A changed selected-app scope requires explicit Resume.
Actual microphone/system-audio consent, selected-app isolation, safe computer exclusion, source
changes, device release, Teams/Zoom, latency and CPU remain hardware acceptance work. Source labels
are not speaker attribution.

The first version passed generated tests but failed owner recording trials. The repair therefore
needs fresh exact-head hosted checks and new hardware proof; synthetic tests are not that proof.
Use generated or personal non-sensitive test audio for the owner-controlled trial. No live device
permission, recording capability or provider credential was activated by development work. See
`packages/meetings/README.md` and the 6 October connection/reliability plan for proof boundaries.

### Native visibility and unlink verification

`MeetingRecordingPresentationTests`, `MeetingHostLifecycleTests` and `CompanionUnlinkTests` use
synthetic audio, fake devices, memory credentials and synthetic transports to cover T12/T13.
The Mac workflow runs those tests, then `scripts/check-meeting-link-negative-controls.py` removes
each named protection, requires its targeted XCTest assertion failure, restores exact source bytes,
and requires the same test to pass. XCResult JSON/bundles and bounded logs are retained as a CI
artifact. A build failure, crash, empty run or unrelated failure does not count as a negative proof.

`MeetingSourceSelectionTests` adds synthetic source-selection, exact-acknowledgment, Stop-race,
cleanup, system-only and paused-gap regression cases. The gap fixture validates source identities
and the complete epoch lifetime, independently of the shorter audio-capture interval. The hosted
Mac source runner, `scripts/check-meeting-source-negative-controls.py`, requires named XCTest
assertion failures for removed protections and positive results after restoring the source. Its
`--check --self-test` flags validate only mutation anchors and result recognition on Linux.

On Linux, `python3 scripts/check-meeting-audio-portable.py` executes the production C atomics with
concurrent producers and guard-removal checks. `python3 scripts/check-meeting-link-negative-controls.py
--check --self-test` only validates native mutation anchors and the result-validation harness; it
does not compile Swift or execute XCTest. macOS build/test, visible all-Spaces behavior and a real
linked-Mac Start/Unlink trial remain separate required gates. A design mockup is not live proof.

### Same-source audio recovery (#3123)

A verified format or valid sample-clock reconfiguration quiesces both selected tracks, confirms a new server epoch for the identical sources, and restarts automatically with labelled gaps. One episode permits at most three control attempts within a 12-second monotonic budget capped by the current lease; every request and backoff consumes it. Continuously advancing callbacks from the sources that actually faulted restore a later episode budget after two seconds. Service retires an acknowledged recovery's local episode once 30 seconds have elapsed since acknowledgment without another recovery attempt, even if the faulted source stays quiet. This is evaluated on service before processing a newly observed fault; it does not timestamp the hardware fault itself. This cooldown never resets pending control, device acquisition or recording acknowledgment; immediate recurring faults keep the original attempts/deadline, and the recording-wide allowance never resets. Pause, Stop and lost authority cancel async recovery. Replacement acquisition runs on a separate serial owner queue, keeping controls and server polling responsive. Cancellation closes its gates immediately; a blocked native call itself cannot be preempted, so disposal remains owned until it returns. The recovery deadline stays separate from the recording authorization lease, upload remains closed during acquisition, and late acquisition is discarded. Recovery exhaustion pauses with “Audio recovery could not finish. Capture is paused. Press Resume in Moss to try again.” This also covers a slow OS permission answer; it does not imply a server outage or expire a still-live recording grant. Initial device quiescence retains the existing synchronous stop path. Physical microphone/speaker routes, selected-app membership and Moss exclusions remain pinned; real source loss stays a hard pause. Expired old-epoch audio is retired as a gap before Resume and cannot pause the replacement segment. Installed-Mac browser-call and native Teams proof is required before this draft is considered verified.

Automatic recovery may cause macOS to show its own system-audio consent dialog if access was reset. Only the person answers it; Moss never accepts permission automatically. Reported permission-denied errors pause capture; refusal may instead yield silent tap callbacks, so that behavior remains an installed-Mac proof requirement. An unknown preflight is not treated as proof of permission.

Each recording permits at most eight accepted automatic recovery controls, and automatic recovery preserves the last eight of the 64 segments for manual controls. Each accepted control counts even if native acquisition later fails; idempotent retries are free. Neither healthy audio nor the completed 30-second cooldown resets that recording-wide allowance. Frequent failures therefore pause visibly instead of exhausting every segment automatically.

Deploy the matching Moss server before updating Trail Marker: an older server rejects the new recovery command and status. With computer audio selected, a speaker/reference change during echo-cancellation startup fails the pinned Start, rather than falling back to plain microphone capture; eligible format/setup incompatibilities can still use the same-microphone fallback after complete disposal.
