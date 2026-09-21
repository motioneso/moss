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
