# Trail Marker

The native macOS companion for Moss. Menu-bar only app; see
`docs/specs/Trail Marker/trail-marker-design-guide/DESIGN_GUIDE.md` for the design authority and
`docs/superpowers/specs/2026-09-20-trail-marker-mac-companion.md` for the spec.

This app lives outside the pnpm workspace (`apps/trail-marker/` has no `package.json`), because its
tests need a Mac and its CI job is a separate `macos-14` GitHub Actions runner.

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
