# Meeting retrieval and native feedback audit repairs

Date: 2026-10-11. Status: bounded implementation plan; installed acceptance pending.

Build task: [#3397](https://github.com/motioneso/moss/issues/3397). The coordinator-approved
[umbrella plan](2026-10-11-ux-audit-repairs.md) was committed before product changes.

## Scope and source grounding

This lane implements MF-01 and MF-08 from the approved Moss user experience audit.
MF-07 remains held. Work is based on the current Meetings presentation draft,
[#3349](https://github.com/motioneso/moss/pull/3349), at
`9e44c081778137bf49df188d04b2260138e01d4d` (tree
`8386524326acd312daf00d54ad3dc7c951dac05a`). The new audit branch preserves that
owner's branch and acceptance artifacts. No Finance behavior is changed by this lane.

- MF-01 is current: `TranscriptTimeline` filters `snapshot.segments` locally, while its
  omission notice tells the person to search for omitted lines. Selected-meeting chat
  independently retrieves retained transcript revisions; this repair adds no retrieval API.
- MF-08 is current: This Mac uses `try?` for login-item changes and updates only its
  approval flag afterward. A failed request can leave the toggle showing the requested
  state. The approved [Trail Marker specification](../specs/2026-09-20-trail-marker-mac-companion.md)
  already requires native registration errors and recovery.
- MF-07 is current: Open meeting in Moss is disabled during recording, recovery and
  stopping. `openMeetingInBrowser` opens the activation URL, but invalid activation
  takes the host's error path. This is insufficient evidence to alter lifecycle behavior.

Existing [#2560](https://github.com/motioneso/moss/issues/2560) owns native foundation,
startup and installed acceptance. [#3110](https://github.com/motioneso/moss/issues/3110)
owns early-resume microphone-loss investigation. [#3124](https://github.com/motioneso/moss/issues/3124)
owns speaker separation and its retention amendment. These are not replaced or implemented
by this lane. The checked open PR inventory has no native capture production owner overlap
with the exact native files assigned here.

## Approved product decisions

### MF-01: describe the bounded local filter honestly

Keep existing snapshot bounds, owner checks, revision binding, evidence validation, cache
lifecycle and full retained chat retrieval unchanged. Label the field Search transcript
timeline. State that search checks only loaded timeline lines, excluding separate cited
excerpts even when those are visible. Make an empty match describe the loaded timeline
rather than the entire retained meeting or all visible text. When lines are omitted, point
to a cited timestamp for retained evidence outside the view. Meeting chat can use that
evidence when its configured model is ready. Do not promise
that this local field searches all retained text. Full-text local search is separate scope.

### MF-08: show confirmed native login-item state

Use an independently testable state value with an injected login-item service. After both
successful and failed changes, read the actual macOS status. The toggle is on only when
macOS reports enabled. A successfully registered item still requiring approval stays off
with a plain explanation and Open System Settings action. Surface registration and
unregistration failures and preserve their recovery action. Show an unavailable status
without calling it enabled. Refresh read-only status when This Mac appears and when the
app becomes active after System Settings. AppDelegate hosts this pane in an
NSHostingController window, so use the existing AppKit app-activation notification pattern.
A refresh must not issue register/unregister; test the event through the actual hosted pane.

Keep the ServiceManagement adapter, native SwiftUI Form/Toggle/Text/Button pattern and
existing device rename behavior. Do not alter onboarding, connection enablement,
permissions, capture, updater or distribution. Onboarding also has a swallowed login-item
error in `finishDeviceSetup`; this is a separate #2560 native foundation follow-up, not
silently covered by the This Mac repair.

## Ownership and implementation sequence

1. Commit this grounded plan after the coordinator identifies the umbrella task.
2. Add failing tests for local search scope and unmatched loaded lines, then change only
   `packages/meetings/src/web/meeting-transcript.tsx` and its existing unit test.
3. Add the login-item state seam and native XCTest cases; adapt LoginItemService and
   ThisMacPane. Cover failed enable, failed disable, actual-state changes even on throw,
   pending approval, unavailable status, retry and read-only refresh. Add a hosted-pane
   regression that posts repeated app-activation notifications and observes actual status
   readback without register/unregister calls.
4. Keep the owning Meetings manifest truthful. Submit the precise core native app-map
   delta to the integration owner for the same PR; shared app-map declarations and
   shared test contracts remain coordinator-owned.
5. Author a real-route isolated UAT spec for a retained transcript exceeding the 500-line
   snapshot. Verify the UI's limited search, loaded match and unmatched omitted phrase,
   cited evidence outside the cap, return/navigation and unchanged capture status.
   No response interception or provider setup is part of this proof.
6. Run available focused unit, formatting, lint, type, app-map and static checks. Record
   what fails, what passes and what cannot run. Prepare a draft PR for coordinator review.

The coordinator confirmed #3397 and approved this lane plan before product edits.

## MF-07 hold and exact native proof required

Leave MeetingCaptureView and all recording guards unchanged. The native owner must first
confirm whether the disablement is an intentional lifecycle constraint. On a supported
installed signed Mac app with authorized synthetic recording, prove navigation during
recording and recovery leaves capture phase, sources, authority, buffer bounds, recording
indicator, Pause and Stop unchanged. Include browser sign-in/account mismatch, invalid or
stale activation, repeated Open, window dismissal and return, and stopping/cleanup. Verify
Moss browser playback remains excluded from computer-audio capture. Only then consider a
bounded enablement repair. Mac unit/CI success is not signed-runtime acceptance.

## Verification boundaries

The current executor is Linux and has no Swift/Xcode/macOS runtime. The new native XCTest
cases require the repository's existing macos-15 build/test workflow. Real login-item
registration, System Settings approval/rejection, actual logout/restart startup and
VoiceOver still require the installed Mac app under #2560. No native recording, OS
permission change, signed build, provider request, product data, merge or deployment is
authorized or claimed here. Database-touching tests run only through the verify-gate's
throwaway-server procedure; an unavailable Docker gate stays explicitly unverified.

Apple's [SMAppService status documentation](https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum)
distinguishes enabled, not registered, approval required and not found. The UI must reflect
those outcomes rather than treating a successful method call as proof of enabled startup.

## Release note

Category: Fixed

Title: Clearer meeting search and Mac startup feedback

Description: Meeting search explains which transcript lines it checks, and Mac startup
settings show the confirmed state with clear recovery when a change fails.
