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
        "name": "T12-silence-flat", "test": "testWaveformIsFlatOnSilentMissingOrNonfiniteInputIncludingReconnect",
        "before": "        if captured == 0 {", "after": "        if captured < 0 {", "assertion": "XCTAssertTrue failed",
    }),
    ("Meetings/MeetingRecordingPresentation.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-terminal-surfaces", "test": "testEveryTerminalPhaseClearsBothSurfacesAndWaveform",
        "before": "        guard [.ready, .recording, .paused].contains(phase) else { stop(); return }",
        "after": "        guard active else { return }", "assertion": "XCTAssertFalse failed",
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
    ("Meetings/MeetingAudioBuffer.swift", "MeetingRecordingPresentationTests", {
        "name": "T12-actual-captured-level", "test": "testActualCapturedPeakExpiresAndPauseNeverDisplaysRetainedAudio",
        "before": "        MeetingAudioLevelStore(displayLevel, peak, host)",
        "after": "        MeetingAudioLevelStore(displayLevel, 0, host)", "assertion": "XCTAssertEqual failed",
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    for source, test_class, control in CONTROLS:
        select(source, test_class, control)
    if args.self_test:
        # The original harness self-test has an XCTAssertNil fixture; preserve its exact
        # assertion discriminator rather than weakening the test for new control types.
        RUNNER.CONTROLS = ({"test": "fixture", "assertion": "XCTAssertNil failed"},)
        RUNNER.self_test()
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
