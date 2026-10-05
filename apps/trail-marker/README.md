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

- **Keychain**: generic-password items under service `com.moss.trailmarker` (the link credential,
  and Backtrack's buffer key). Remove them with Keychain Access (search "trailmarker") or
  `security delete-generic-password -s com.moss.trailmarker` (once per item).
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
above; this branch does not provide a signed distribution or Windows recorder.

Moss can run on a remote or headless server. Run Trail Marker on the **recording client Mac**:
the computer whose microphone and meeting-app/computer audio you want to capture. Moss does not
need to be installed on that Mac, and recording does not use microphones or audio devices attached
to the Moss server. The prepared companion sends captured audio to Moss for the configured
processing route.

On the recording Mac, open Moss at its public HTTPS address and link Trail Marker to the same
origin, including its port. “Same origin” means the same remote Moss server, not the same computer.
Unencrypted HTTP is accepted only for loopback development addresses (`localhost`, `127.0.0.1`,
or `::1`). A TLS reverse proxy must expose the final canonical origin directly: the native capture
client does not follow redirects, and the meeting handoff currently expects Moss at the origin
root rather than a path-prefix deployment.

In Moss, create or reopen a meeting and choose Open recorder. In Trail Marker, explicitly prepare
this Mac's microphone. Approve the named device in that meeting's browser panel, select the
microphone and capture mode, acknowledge the notice, then press Record. The listed audio sources
belong to that named companion. Viewing or controlling the meeting from a browser on another
computer does not switch capture to that browser's machine or to the server. Browser-only capture
is not implemented. Preparing or approving alone does not start recording. Transcription is
configured only through AI providers in Moss.

The separate meeting menu-bar indicator opens Pause/Stop controls. It remains visible when the
browser changes pages. Pause All, logout and quit close meeting capture; a failed device cleanup
blocks continuation and keeps a visible cleanup state. Reconnect and app restart never resume
recording automatically. Capture approval is ephemeral and must be renewed after restart.

This is an unverified native development checkpoint. Use generated, non-sensitive test audio only
until provider use and recording have been separately authorized. Actual microphone/system-audio
consent, selected-app exclusion, computer-mode process identity, device release, Teams/Zoom,
latency and CPU need testing on real hardware. Computer mode conservatively pauses on process
changes; inability to resolve this host's audio-process identity disables that mode. Source labels
are not speaker attribution. See `packages/meetings/README.md` for server and proof boundaries.
