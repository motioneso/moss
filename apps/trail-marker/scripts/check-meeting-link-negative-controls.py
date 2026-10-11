#!/usr/bin/env python3
"""T12/T13 guard-removal XCTest controls, using the existing fail-closed XCResult runner.

Hosted Mac execution only. --check/--self-test validate anchors and the runner but
are not Swift or security proof. Every mutation is restored before its green run.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import signal
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("meeting_negative", HERE / "check-meeting-negative-controls.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
CONTROLS = [
    ("Meetings/MeetingCaptureRuntime.swift", "MeetingStartupSourceRecoveryTests", {
        "name": "startup-retry-never-offered", "test": "testAcknowledgedAndUnacknowledgedOffersBothPermanentlyBlockStartupRetry",
        "before": "                  !currentEpochEverOffered else { return false }",
        "after": "                  true else { return false }",
        "assertion": "Retry requires that this epoch never offered PCM, even after receipt emptied the ring",
    }),
    ("Meetings/MeetingCaptureRuntime.swift", "MeetingStartupSourceRecoveryTests", {
        "name": "startup-retry-erases-uncertain-pcm", "test": "testQuarantineErasesBothSourcesAndReportsEveryDroppedIntervalWithoutReadingSamples",
        "before": "if let gap = entry.buffer.discardUnsentStartupAudio() { retainedGaps.append(gap) }",
        "after": "if let gap = Optional<MeetingAudioGap>.none { retainedGaps.append(gap) }",
        "assertion": "PCM captured before the missing-source notice must be erased",
    }),
    ("Meetings/MeetingCaptureInventory.swift", "MeetingStartupSourceRecoveryTests", {
        "name": "startup-retry-rejects-new-moss", "test": "testObservedAdditionalMossCannotQualifyEvenIfItVanishesFromTheNextSnapshot",
        "before": "        guard excluded.allSatisfy({ original.excluded.contains($0) }) else { return false }",
        "after": "        // Mutation: ignore a newly observed excluded process.",
        "assertion": "A newly observed Moss process must never qualify for startup reconfirmation",
    }),
    ("Meetings/MeetingAudioBuffer.swift", "MeetingMicrophoneCaptureTests", {
        "name": "startup-retry-rejects-late-native-render", "test": "testRenderHeldBeforeReceiverCannotPublishPreRecheckAudioAfterHostGateReopens",
        "before": "        guard host >= sourceVerificationCutoff, interval.start >= sourceVerificationCutoff else {",
        "after": "        guard true else {",
        "assertion": "A native callback held before receive must not escape after recheck",
    }),
    ("Meetings/MeetingStartupSourceValidation.swift", "MeetingHostLifecycleTests", {
        "name": "startup-source-one-confirmation", "test": "testFirstStartReconfirmsOneMissingMicrophoneWithoutResumeOrSendingUncertainPCM",
        "before": "           runtime.beginStartupSourceRecheck(at: ports.now()) {",
        "after": "           false {",
        "assertion": "One Start must survive a reconfirmed startup source omission without Resume",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-accepted-start-pill", "test": "testPillAndRedDotShowThroughPauseAndHideResetsOnlyAtNextStart",
        "before": "        active = true", "after": "        active = false", "assertion": "XCTAssertTrue failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-paused-red-dot", "test": "testPillAndRedDotShowThroughPauseAndHideResetsOnlyAtNextStart",
        "before": "var showsRedDot: Bool { active }", "after": "var showsRedDot: Bool { active && state != .paused }",
        "assertion": "XCTAssertTrue failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-silence-flat", "test": "testMeterIsFlatOnSilentMissingOrNonfiniteInputIncludingReconnect",
        "before": "        if captured == 0 {", "after": "        if captured < 0 {", "assertion": "XCTAssertTrue failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-three-captured-bars", "test": "testMeterContainsOnlyThreeLatestCapturedPeaks",
        "before": "private(set) var meterLevels = [Float](repeating: 0, count: 3)",
        "after": "private(set) var meterLevels = [Float](repeating: 0, count: 8)", "assertion": "XCTAssertEqual failed",
    }),
    ("Design/DesignTokens.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-pure-white-capsule", "test": "testRecordingPillPaletteMatchesReferenceInLightAndDarkAppearance",
        "before": "static let recordingSurface = SwiftUI.Color.white",
        "after": "static let recordingSurface = SwiftUI.Color.black", "assertion": "XCTAssertEqualWithAccuracy failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-terminal-surfaces", "test": "testEveryTerminalPhaseClearsBothSurfacesAndMeter",
        "before": "        guard [.ready, .recording, .recovering, .paused].contains(phase) else { stop(); return }",
        "after": "        guard active else { return }", "assertion": "XCTAssertFalse failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-hidden-interruption-warning", "test": "testInterruptionWarningForcesHiddenPillVisibleUntilExplicitlyCleared",
        "before": "var showsPill: Bool { showsAttention || (active && !hidden) }",
        "after": "var showsPill: Bool { active && !hidden }", "assertion": "XCTAssertTrue failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-cleanup-warning-survives-stop", "test": "testCleanupErrorRemainsVisibleAfterRecordingSurfacesWereStopped",
        "before": "var showsAttention: Bool { interruptionWarning != nil || (active && state == .recovering) }",
        "after": "var showsAttention: Bool { active && (interruptionWarning != nil || state == .recovering) }",
        "assertion": "A real cleanup error must survive terminal-phase presentation updates",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-recovery-keeps-pause", "test": "testRecoveringOverridesHideWithDistinctVisibleStatusAndPauseControl",
        "before": "        canPause = phase == .recording || phase == .recovering",
        "after": "        canPause = phase == .recording",
        "assertion": "Pause remains usable while recovery is pending",
    }),
    ("Meetings/MeetingRecordingPill.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-every-space", "test": "testPanelFloatsOnEverySpaceWithoutActivationOrHardware",
        "before": "[.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]",
        "after": "[.fullScreenAuxiliary, .ignoresCycle]", "assertion": "XCTAssertTrue failed",
    }),
    ("Meetings/MeetingCaptureView.swift", "MeetingHostLifecycleTests", {
        "name": "T12-rendered-red-dot", "test": "testAcceptedStartShowsPillAndDotThroughPauseThenStopClearsBoth",
        "before": "title.addAttribute(.foregroundColor, value: NSColor.systemRed, range: NSRange(location: 0, length: 1))",
        "after": "title.addAttribute(.foregroundColor, value: NSColor.labelColor, range: NSRange(location: 0, length: 1))",
        "assertion": "XCTAssertEqual failed",
    }),
    ("Meetings/MeetingCaptureHost.swift", "MeetingHostLifecycleTests", {
        "name": "T12-hide-never-pauses", "test": "testHideAndNativeCloseKeepCaptureRunningAndMenuRestoresPill",
        "before": "func hideRecordingPill() { recordingPresentation.hide() }",
        "after": "func hideRecordingPill() { recordingPresentation.hide(); pauseFromUserClick() }",
        "assertion": "XCTAssertEqual failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-show-preserves-session", "test": "testShowOnlyRestoresVisibilityAndNextStartResetsHide",
        "before": "mutating func show() { hidden = false }",
        "after": "mutating func show() { acceptedStart() }", "assertion": "XCTAssertEqual failed",
    }),
    ("Meetings/MeetingAudioBuffer.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-actual-captured-level", "test": "testActualCapturedPeakExpiresAndPauseNeverDisplaysRetainedAudio",
        "before": "        MeetingAudioLevelStore(displayLevel, peak, host)",
        "after": "        MeetingAudioLevelStore(displayLevel, 0, host)", "assertion": "XCTAssertEqualWithAccuracy failed",
    }),
    ("Meetings/MeetingCaptureHost.swift", "MeetingHostLifecycleTests", {
        "name": "T12-paused-lease-expiry", "test": "testLeaseExpiryClearsPausedSessionAndDropsItsRetainedAudio",
        "before": "            if leaseDeadlineNanoseconds > 0, now >= leaseDeadlineNanoseconds {",
        "after": "            if leaseDeadlineNanoseconds > 0, now == UInt64.max {",
        "assertion": "XCTAssertFalse failed",
    }),
    ("Meetings/MeetingCaptureRuntime.swift", "MeetingHostLifecycleTests", {
        "name": "T12-terminal-unsent-audio", "test": "testEveryIdentityStopPathClearsSurfacesAndDiscardsUnsentAudio",
        "before": "        pending.forEach { $0.buffer.close() }\n        pending.forEach { $0.buffer.discard() }\n        pending.removeAll()",
        "after": "        pending.forEach { $0.buffer.close() }\n        pending.removeAll()",
        "assertion": "XCTAssertNil failed",
    }),
    ("App/ConnectionRuntime.swift", "CompanionUnlinkTests", {
        "name": "T13-logout-before-delete", "test": "testLogoutMustSucceedBeforeEitherCredentialIsDeleted",
        "before": "                    try await client.logout(credential: credential)",
        "after": "                    _ = client; _ = credential", "assertion": "XCTAssertEqual failed",
    }),
    ("App/ConnectionRuntime.swift", "CompanionUnlinkTests", {
        "name": "T13-failed-logout-retains-keys", "test": "testFailedLogoutRetainsBothCredentialsAndCanRetry",
        "before": "                    try await client.logout(credential: credential)",
        "after": "                    try? await client.logout(credential: credential)", "assertion": "XCTAssertNotNil failed",
    }),
    ("App/ConnectionRuntime.swift", "CompanionUnlinkTests", {
        "name": "T13-persisted-unlink-intent", "test": "testRestartKeepsPendingUnlinkAndNeverSendsHeartbeatOrStartsCapture",
        "before": "        if preferences.unlinkPending, identity != nil {",
        "after": "        if false, identity != nil {", "assertion": "XCTAssertEqual failed",
    }),

]


def select(source, test_class, control):
    RUNNER.SOURCE = RUNNER.APP / "TrailMarker" / source
    RUNNER.TEST_CLASS = test_class
    RUNNER.CONTROLS = (control,)
    return RUNNER.validate_sources()


def self_test():
    # Keep the original generic runner's fail-closed checks as well as this concrete
    # assertion spelling observed in macOS run 37522944746, job 112472689605.
    RUNNER.CONTROLS = ({"test": "fixture", "assertion": "XCTAssertNil failed"},)
    RUNNER.self_test()
    _, test_class, control = next(entry for entry in CONTROLS
                                  if entry[2]["name"] == "T12-actual-captured-level")
    RUNNER.TEST_CLASS = test_class
    failure = {
        "testCaseName": f"{test_class}.{control['test']}()",
        "message": 'XCTAssertEqualWithAccuracy failed: ("0.0") is not equal to ("0.75") +/- ("0.0001") - Display the maximum actual source peak',
    }
    negative = {"metrics": {"testsCount": "1", "testsFailedCount": "1"},
                "issues": {"testFailureSummaries": [failure]}}
    RUNNER.verify_result(negative, 65, control, True)
    # The real mutation also fails the later positive-level assertion. It is still
    # one executed test; every failure must belong to it and be an XCTest assertion.
    additional = {**failure, "message": 'XCTAssertGreaterThan failed: ("0.0") is not greater than ("0.0")'}
    RUNNER.verify_result({**negative, "issues": {"testFailureSummaries": [failure, additional]}},
                         65, control, True)
    RUNNER.verify_result({"metrics": {"testsCount": "1"}, "issues": {}}, 0, control, False)
    invalid = [
        ({**negative, "issues": {"testFailureSummaries": [additional]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [
            {**failure, "message": "XCTAssertEqual failed: unrelated equality assertion"}]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [failure,
            {**failure, "testCaseName": "Unrelated.test()"}]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [failure,
            {**failure, "message": "Failed to launch test host"}]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [
            {**failure, "message": "Test host crashed"}]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [failure],
            "errorSummaries": [{"message": "Compiler failure"}]}}, 65),
        ({**negative, "metrics": {"testsCount": "0", "testsFailedCount": "1"}}, 65),
        (negative, 0),
    ]
    for result, code in invalid:
        try:
            RUNNER.verify_result(result, code, control, True)
        except RuntimeError:
            continue
        raise RuntimeError("T12 matcher accepted an unrelated assertion, setup/crash/build failure, empty run or wrong exit")
    print("T12 captured-level report recognized; unrelated assertions and non-test failures rejected.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    for source, test_class, control in CONTROLS:
        select(source, test_class, control)
    if args.self_test:
        self_test()
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} T12/T13 anchors. Native execution remains required.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-link-negative-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Native T12/T13 evidence directory: {folder}", flush=True)
    for source, test_class, control in CONTROLS:
        original = select(source, test_class, control)
        RUNNER.run_control(control, original, folder)
    print("T12/T13 guard removals failed named assertions and passed after restoration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
