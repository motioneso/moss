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
