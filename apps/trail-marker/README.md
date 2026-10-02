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

Trail Marker keeps two things outside the app bundle, so quitting or reinstalling the app does not
reset them:

- **Keychain**: a generic-password item, service `com.moss.trailmarker`. Remove it with Keychain
  Access (search "trailmarker") or `security delete-generic-password -s com.moss.trailmarker`.
- **Preferences**: `UserDefaults` under the app's bundle identifier. Reset with
  `defaults delete com.moss.trailmarker`.

Run both before re-testing first-run linking from a clean state.

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

Build and test from `~/Jarv1s/apps/trail-marker`. Backtrack's preview remembers text only in memory;
quitting or restarting the app clears that text. Run the new build only after finishing with any
history you want to consult in the current instance.

The retry checks recent screen fingerprints after switches as well as periodically, refreshes
each screen after five minutes, and pauses capture after five minutes without input. Keyboard or
mouse input resumes capture within five seconds. A window whose reads keep finding nothing new is
read less often, down to once a minute, and periodic reads wait while you type (at most 30
seconds); switching windows is never delayed. Recognition runs without language correction on
captures of at most 1600 px. This means passive reading or screen sharing without
input pauses too; include those cases when judging usefulness.

After launching the trial build and turning Backtrack on through its existing consent flow, sample
a normal working day from another terminal:

```sh
cd ~/Jarv1s/apps/trail-marker
bash scripts/backtrack-cpu-trial.sh
bash scripts/backtrack-metrics-report.sh 8h
```

The CPU sample runs for about eight hours and fails above 3% mean CPU or if the process exits before
all samples are collected. The first CPU reading is discarded because it is not an interval
measurement. The metrics report estimates OCR, capture and thumbnail costs, split by trigger, using
process CPU deltas that can overlap other work. A short or idle-only run cannot pass the working-day
gate. Record the sample and whether the text answers three real "what did I see?" questions on the
PR; Phase 2 stays gated until both CPU and usefulness pass.
