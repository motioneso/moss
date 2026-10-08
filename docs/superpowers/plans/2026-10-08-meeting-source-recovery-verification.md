# #3123 verification record

Branch base: main `2c81aa48418f4b7dcb80218e72629e5bb495c642` (after #3120).

## Local evidence

- Capture backend regression run: 24 Vitest files / 348 tests passed, including complete meeting manifest and app-map integrity.
- Related web presentation/source/auto-pause run: 4 Vitest files / 61 tests passed. The new recovery-label test was observed failing against the previous `Starting…` behavior before the fix.
- Actual app-map builder (`node --import tsx scripts/build-app-map.ts`) passed. This executes the real built-in registry composition and compatibility validation.
- Full repository ESLint and Prettier passed; scoped TypeScript checks passed; test TypeScript configuration passed. Final root TypeScript passed with a 3 GiB heap after fixing two test-fixture types and restoring ignored local dependency hoists required by the checked-in configuration. Earlier attempts hit resource limits; only the final run is reported as passing.
- Backend negative controls: removing the recovery-only selection/state/open-epoch guard caused nine intended failures; removing locked binding checks caused six intended failures. Source was restored afterward.
- Portable audio C checks and 27 negative probes passed; process-path C check and its BSD-denial negative control passed.
- Native mutation runners' portable anchor/semantic-recognition checks passed. These are harness checks only, not Swift or native behavior proof.
- Independent review identified and implementation addressed mixed soft/hard fault priority, teardown fault draining, stale callback-health counters, invalid rate remapping, unmapped acquisition rollback, failed recovery converging to Pause, hidden terminal warnings and mapped/wire gap overlap. A second independent concurrency pass reviews staged ownership, continuing polling, late-result disposal, pending cleanup and cancellation gap identities.

## Checks unavailable here

This executor has no Swift/Xcode or Docker. The database gate was attempted only through `scripts/run-gate.sh` and stopped with exit 4 (`docker not found`). No database suite was run outside the gate. Native XCTest, Apple SDK compilation, hosted mutations and real-storage integration results must be obtained from CI for the pushed head.

## Installed-Mac proof required

Keep the PR draft and unverified until these paths have real installed-app evidence:

1. Browser call sample and native Teams launched before recording and mid-recording; repeat call start/end. Confirm automatic recovery, a fresh server epoch, post-recovery uploads/transcript and labelled gaps.
2. Microphone-only, computer-only and combined modes. Reopened echo diagnostics must reflect actual VPIO/HAL state and retain the same microphone/reference route.
3. Pause/Stop during control request, delayed device acquisition, any OS consent dialog and status acknowledgment. Late successful responses must not reopen capture. Replacement acquisition is isolated from the host/control queue and has blocked-start synthetic coverage. Native calls themselves are not preemptible; do not infer a universal hardware-disposal timeout from the admission deadline. Initial quiescence retains the existing synchronous stop path.
4. Permission revocation/reset, real device disconnect, speaker-route change, selected-app exit and changed Moss exclusions. These remain hard pauses, with no widened capture.
5. Delayed Resume beyond retention with never-offered, acknowledged and receipt-unknown old audio. Old loss is a gap; fresh epoch sequencing stays independent.
6. Hide the recording pill, then cause an unrecoverable interruption or cleanup failure. Warning text and reason must stay visible, with appropriate Resume/Stop controls.
7. Check native panel layout and wrapping on a real Mac using executable assertions or bounded textual evidence; do not substitute screenshots or fabricated network responses for the live-path gate.

The owner approved automatic recovery that may show macOS’s own system-audio consent dialog; only the person may answer it. A surfaced permission-denied error is a hard pause, but refusal may instead produce silent tap callbacks and its behavior is still unverified. The implementation does not call application permission-request APIs during recovery or accept consent automatically. macOS has no documented Core Audio tap permission preflight in this path; an unknown permission is not evidence of a grant. The PR discloses this narrow exception; permission-reset and refusal behavior still require live verification.

## Independent PR review follow-up

The review requires a late-adoption/status-ack deadline regression, recording-wide automatic recovery limits with manual segment headroom, explicit source-edit cancellation, single pause diagnostics, user-facing dialog metadata, and server-first release guidance. Hosted checks and the installed-Mac cases must cover the amended head. In particular, answering an OS dialog near the deadline must not end the recording grant; refusal must be tested rather than inferred from a successful device start.

Review follow-up local checks passed: 27 capture/manifest/link unit files (416 tests), root and test TypeScript, scoped ESLint/Prettier, and the actual app-map build. Three additional server limit/count guard removals failed the intended assertions, then were restored and passed. The independent reviewer separately reran 48 limit/source/receipt tests. Native portable harness checks include 9 acquisition and 13 reconfiguration controls; hosted Swift execution remains required. A lock-reentrant diagnostic getter found while investigating hung native CI now has a bounded regression and mutation, so the test reports failure rather than hanging.
