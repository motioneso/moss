# Meetings audit repair evidence

Date: 2026-10-11. Task: [#3397](https://github.com/motioneso/moss/issues/3397).
Status: code-complete, unverified; local review packet, no publication or merge approval.

## Scope and stack

The approved [lane plan](../plans/2026-10-11-audit-meetings.md) implements MF-01
and MF-08. MF-07 remains held and production capture behavior is unchanged.

- Exact prerequisite: [#3349](https://github.com/motioneso/moss/pull/3349), commit
  `9e44c081778137bf49df188d04b2260138e01d4d`, tree
  `8386524326acd312daf00d54ad3dc7c951dac05a`.
- Preserved plan commits: `7f8080be18c16ba98c6c34eab072b5edc08bd913` and
  `4b877262905464e88813c4cd71dbfb71d1d84bc5`.
- Web repair: `7084e3a9154af0a5e1e0e64fbc98e3897d5e2194`.
- Native repair: `bed633063f7b37f42bae09e989a1e35fc2c36207`, product tree
  `d68a35c6e7c8a4da8c90dd6d2ac8a7f1c1325e31`.
- Coordinator native app-map commit `136f913d3` and real-route trigger coverage commit
  `3dcdc6340` are now included. The existing UAT search locator update is coordinator-owned;
  it must use the final Search transcript timeline label before publication.

MF-01 changes only local search wording, scope description and status accessibility;
retained evidence, retrieval bounds, query lifecycle and capture paths are unchanged.
The owning manifest declares the local search boundary and configured-chat requirement.

MF-08 reads actual ServiceManagement status after both success and failure, keeps the
toggle bound to confirmed enabled state, surfaces failures with System Settings recovery,
and refreshes without registration calls when This Mac appears or the app becomes active.
Nine state XCTest cases cover successful requests, failure rollback, partial status change on
throw, approval, unavailable status, retries and read-only recovery. One hosted-pane XCTest
covers the AppKit activation event path. All ten are authored but have not been compiled
or run in this Linux executor.

## Executed checks

The 03:27–03:30 UTC replacement review made no product edits. Product hashes matched
before and after explicit-path commits; the commit hook did not change checked bytes.

- Focused final regression run: exit 0, 56/56 tests in five files:
  `meeting-transcript-web`, `meeting-transcript-query-lifecycle`,
  `meeting-citation-navigation`, `meeting-chat`, and `meeting-manifest`.
  Command: `node node_modules/vitest/vitest.mjs run` followed by the five matching
  `tests/unit/` paths.
- Scoped ESLint: exit 0 with `--max-warnings=0` for both changed TypeScript product files,
  both changed unit tests and the unique UAT spec.
- Scoped Prettier: exit 0 for those same five files.
- File-size, design tokens, UI classes, migrated sections, UI catalogue, package
  dependencies and app-map generation: exit 0 via the existing scripts loaded with
  `node --import tsx`; the ordinary tsx CLI had previously hit sandbox IPC restrictions.
- Ambient-date, development-password and migration-number scans: exit 0. The password
  scanner's existing public-history/rotation caveat remains; this is a scanned-working-files
  result, not an all-clear. Migration comparison checked 283 local and base migrations,
  with no cross-PR claims checked.
- `git diff --check`: exit 0.
- Native `check-backtrack-sources.sh` and `--self-test`: exit 0; all seven planted
  source violations detected. This checks source boundaries, not native runtime behavior.
- Playwright collection: exit 0, one Chromium case. `--list` used a non-serving loopback
  URL solely to load the config; no browser or service was started. An initial collection
  call without the required base URL correctly failed config validation.

The pre-replacement checkpoint reported four expected failing MF-01 tests with all
14 existing tests passing before the repair, followed by the 56/56 restored pass.
The replacement independently reran the restored suite, not that baseline mutation.

The checkpoint also records exit-0 root, tests and web TypeScript checks at 03:26 UTC
with `NODE_OPTIONS=--max-old-space-size=8192`; the default 2 GB attempt had exhausted
its heap before useful diagnostics. Those checks preceded the initial commits on identical
product bytes, but do not cover the subsequent review corrections below. A new final-head
typecheck is queued through the integration owner, who serializes memory-intensive verification. Neither result covers excluded external modules.

Toolchain observed: Node 24.19.0, TypeScript 6.0.3, ESLint 10.4.1, Prettier 3.8.3,
Vitest 4.1.8 and Playwright 1.60.0; installed workspace package manager is pnpm 10.6.2.

## Independent-review corrections, 03:36–03:40 UTC

- Web correction `02b0b4855d760c88915649e51bcc7d6ca62c47bc` names Search transcript
  timeline, limits help and no-match text to loaded timeline lines, and explicitly excludes
  separate cited excerpts. It leaves excerpt rendering and all retrieval logic unchanged.
- Native correction `f638f01a1fe297aba85ecef41494f4e6478e2afa` uses the existing
  AppKit `NSApplication.didBecomeActiveNotification` pattern rather than SwiftUI scenePhase,
  because AppDelegate manually hosts the settings window. This Mac accepts its existing
  service protocol so the actual pane can be hosted with an injected status service.
- The new server-rendered combined regression and real query/render lifecycle regression
  prove that an older separately displayed citation survives both unmatched and matched
  timeline search. Searching adds no transcript/evidence requests and leaves the retained
  query data unchanged. Before product corrections, five web tests failed with fourteen
  prior tests passing; the combined lifecycle regression failed with three prior tests passing.
  After correction, the final focused five-file aggregate passed 58/58, exit 0.
- The real-route UAT now checks the combined citation/search state, preserves the cited
  excerpt on match/no-match/Close, and uses the timeline label. It remains unexecuted.
- `ThisMacPaneTests` constructs the production pane in a manual NSHostingController/NSWindow,
  observes its initial approval-required read, changes the fake service status, posts repeated
  app-activation notifications, and asserts enabled/disabled readback with zero registration,
  unregistration or System Settings calls. It does not start ConnectionRuntime and uses an
  isolated defaults suite. This is authored native event coverage, not an executed proof.
- Scoped ESLint and Prettier, diff check, file-size/design/UI/migrated/catalogue/dependency
  checks, app-map generation and native source check plus all seven self-tests passed on
  corrected owned product bytes. One updated Chromium UAT case collected successfully;
  no browser or service was started. Heap checks were deferred to the integration owner.
- MF-07's exact MeetingCaptureView/MeetingCaptureHost files still match the #3349 base.
  No publication, capture operation, OS login-item change, merge or deployment occurred.

## Unexecuted acceptance and hard holds

- Docker CLI/socket is absent. No full foundation gate, database-touching test or live UAT
  was run; no direct database fallback was attempted.
- Swift, Xcode and macOS are absent. The existing `trail-marker-mac.yml` macos-15
  build/XCTest workflow remains required after publication is authorized.
- Installed signed-Mac approval/rejection, logout/restart startup and VoiceOver remain
  required under [#2560](https://github.com/motioneso/moss/issues/2560).
- The real-route UAT spec is authored and collected only. It seeds 501 synthetic retained
  lines through normal routes, checks loaded match/no-match at 1280/390/320 widths, closes
  and reopens search, resolves exact evidence beyond the cap, compares capture state,
  observes browser capture-write requests and performs ID-specific cleanup. It neither
  requests a model nor proves provider citation quality or active-capture navigation.
- MF-07 is unchanged. Recording, recovery and stopping gates must not be weakened without
  lifecycle intent and installed signed-Mac proof specified in the lane plan.
- [#3110](https://github.com/motioneso/moss/issues/3110) microphone-loss and
  [#3124](https://github.com/motioneso/moss/issues/3124) diarization/retention remain with
  their owners. Onboarding login-item error handling remains a #2560 follow-up outside
  This Mac scope. No Finance, Food/Meals, Job Search or Workshop edits were made.
- Independent coordinator review, final-head CI and live proof are still pending.
  No push, PR, merge, deployment, account change or OS registration was performed here.

## Draft PR content

### Summary

- Explain that transcript search checks loaded timeline lines and excludes separate cited
  excerpts; scope its no-match message to that timeline.
- Show the Mac startup toggle from confirmed macOS state, with visible failure recovery.
- Add bounded regression coverage and a real-route UAT spec; leave active-recording
  navigation unchanged pending signed-Mac proof.

Relates to #3397. Stacked on #3349; preserve its owner and retarget only after that base
lands with affected code rechecked. Code-complete, unverified: live browser and installed
Mac acceptance are absent. Do not merge or mark the task Done.

### Release note

Category: Fixed

Title: Clearer meeting search and Mac startup feedback

Description: Meeting search explains which transcript lines it checks, and Mac startup
settings show the confirmed state with clear recovery when a change fails.
