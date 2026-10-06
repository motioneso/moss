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
  base service does not remove its separate recording proofs. Ordinary logout clears the linked
  identity's recording proofs.
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
capability in that approval; existing paired clients show a one-time upgrade in Moss. The independent
recording proof is stored in this Mac's Keychain; the server holds its hash. Connecting or approving
does not record. Backtrack keeps its separate existing consent and retention behavior.

In Meetings, select this named Mac, a microphone and one of microphone-only, microphone + selected
app, or microphone + computer audio, then choose **Start meeting**. Moss remembers the stable source
identities; Change selects different ones. Missing or ambiguous sources require explicit selection
and never widen capture. First use may request an OS microphone/system-audio permission. If Stop,
revocation or expiry occurs while permission is pending, granting permission cannot start audio.
There is no per-meeting Prepare, approval, notice checkbox or second Record button. Trail Marker
keeps the current browser in place rather than launching the default browser for each meeting.

Viewing Moss from another computer controls the explicitly named recorder; it never switches to
that browser's hardware or the server's hardware. Browser-only capture is not implemented.
Transcription is configured only through AI providers in Moss.

The meeting menu-bar indicator has local Pause/Stop controls and remains visible across browser
navigation. Moss also keeps recording controls available while visiting History or other modules.
Pause closes inputs and starts no new audio uploads. Stop fixes the cutoff and drains only retained
pre-cutoff audio for up to 60 seconds; a new native recording waits for this bounded finalization.
Pause All, logout and quit close capture. Cleanup failures remain visible and block continuation.
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
