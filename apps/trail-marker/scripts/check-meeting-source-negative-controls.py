#!/usr/bin/env python3
"""Hosted-Mac source-change mutations; portable checks are not native XCTest proof.

Each isolated mutation must fail its named semantic XCTest assertion, then pass
after byte-for-byte source restoration. The shared runner rejects empty runs,
build failures, crashes, unrelated assertions and mutations that survive.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import signal
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("meeting_negative", HERE / "check-meeting-negative-controls.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
TEST_CLASS = "MeetingSourceSelectionTests"
LIVE_TEST = "testLiveSourceChangeClosesOldReceiverBeforeControlAndWaitsForExactStatus"
CONTROLS = [
    ("MeetingCaptureHost.swift", {
        "name": "source-synchronous-old-device-close", "test": LIVE_TEST,
        "before": "                try runtime.pause(at: boundary)",
        "after": "                // Mutation: leave the previous capture device and receiver open.",
        "assertion": "Old device must close before source control transport",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-control-ack-keeps-hardware-closed", "test": LIVE_TEST,
        "before": "                self.sourceChangeIntent?.acknowledged = true",
        "after": "                self.sourceChangeIntent?.acknowledged = true\n"
                 "                let selection = try self.ports.readInventory().resolve(body.selection!)\n"
                 "                try self.runtime.resume(selection: selection.selection,\n"
                 "                    readiness: .init(permissionsGranted: true, processingReady: true, meetingDeviceAuthorized: true),\n"
                 "                    permitRetainedAudio: true, at: self.now())",
        "assertion": "Control acknowledgment alone must never open replacement hardware",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-previous-paused-observation", "test": LIVE_TEST,
        "before": "                self.remote = reply.capture\n                self.uploadAdmitted = false\n            } catch {",
        "after": "                self.remote = reply.capture\n"
                 '                self.observed = .init(generation: reply.capture.generation, phase: "paused", errorCode: nil)\n'
                 "                self.uploadAdmitted = false\n            } catch {",
        "assertion": "Source change keeps the previous-generation paused observation",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-exact-control-acknowledgment",
        "test": "testMismatchedSourceControlAcknowledgmentNeverReopensHardware",
        "before": "                guard intent.matches(reply.capture) else { throw MeetingHostError.rejected }\n                self.sourceChangeIntent?.acknowledged = true",
        "after": "                // Mutation: accept a control receipt for a different source choice.\n                self.sourceChangeIntent?.acknowledged = true",
        "assertion": "Mismatched source control acknowledgment must reject the intent",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-exact-status-acknowledgment",
        "test": "testMismatchedSourceStatusAcknowledgmentNeverReopensHardware",
        "before": "        guard intent.acknowledged, intent.matches(capture) else {\n            failSourceChange(MeetingHostError.rejected)",
        "after": "        guard intent.acknowledged else {\n            failSourceChange(MeetingHostError.rejected)",
        "assertion": "Mismatched source status acknowledgment must reject the intent",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-status-revision-fence",
        "test": "testOlderStatusResponseCannotUndoSourceAcknowledgmentOrOpenOldDevice",
        "before": "                guard sourceRevision == sourceChangeRevision else { continue }\n"
                  "                guard reply.capture.grantId == grantId, reply.capture.deviceId == ports.identity()?.deviceId else {",
        "after": "                // Mutation: admit a status reply requested before the source click.\n"
                 "                guard reply.capture.grantId == grantId, reply.capture.deviceId == ports.identity()?.deviceId else {",
        "assertion": "Pre-cutover status must preserve the newer source intent",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-pending-control-suppresses-status",
        "test": "testLostSourceReplyRetriesIdenticalIntentAndSuppressesPausedStatus",
        "before": "            if sourceChangeIntent?.awaitingControl == true {",
        "after": "            if false {",
        "assertion": "No ordinary paused status while source outcome is pending",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-replacement-upload-acknowledgment", "test": LIVE_TEST,
        "before": "submitted: sentObservation, current: observed)",
        "after": "submitted: observed, current: observed)",
        "assertion": "Replacement uploads wait for exact recording-epoch acknowledgment",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-queued-stop-dominance",
        "test": "testStopCancelsQueuedSourceChangeBeforeTransportAndCannotReopen",
        # Mutate Stop's cancellation itself: removing one preflight guard is masked by
        # the transport's independent cooperative-cancellation check.
        "before": "        cancelSourceChange()\n        if cleanupBlocked { _ = terminate(reason: \"Recording stopped.\"); return }\n        localControl(\"stop\")",
        "after": "        // Mutation: Stop leaves its queued source task and intent live.\n        if cleanupBlocked { _ = terminate(reason: \"Recording stopped.\"); return }\n        localControl(\"stop\")",
        "assertion": "Stop must cancel queued source change before transport",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-cleanup-failure-stop-recovery",
        "test": "testCleanupFailureKeepsStopRecoveryAndSendsNoSourceChange",
        "before": "var canStop: Bool { [.recording, .recovering, .paused, .stopping].contains(phase) || (phase == .ready && grantId != nil) || acquisitionPending || cleanupBlocked }",
        "after": "var canStop: Bool { [.recording, .recovering, .paused, .stopping].contains(phase) || (phase == .ready && grantId != nil) || acquisitionPending }",
        "assertion": "Source cleanup failure must preserve Stop recovery",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-cleanup-failure-blocks-control",
        "test": "testCleanupFailureKeepsStopRecoveryAndSendsNoSourceChange",
        "before": "                try runtime.pause(at: boundary)",
        "after": "                try? runtime.pause(at: boundary)",
        "assertion": "Cleanup failure must never send a source control",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-teardown-cancels-intent",
        "test": "testUnlinkAndLeaseExpiryCancelPendingSourceIntent",
        "before": "        cancelSourceChange()\n        sourceSelectionError = nil",
        "after": "        sourceSelectionError = nil",
        "assertion": "Unlink and lease expiry must cancel the source intent",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-system-only-skips-microphone-permission",
        "test": "testSystemOnlyStartNeverRequestsMicrophonePermissionOrCreatesMicrophone",
        "before": "        if selection.microphone != nil, ports.microphonePermission() != .granted {",
        "after": "        if ports.microphonePermission() != .granted, selection.microphone != nil {",
        "assertion": "System-only capture must not consult microphone permission",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-pause-gap-authoritative-boundary",
        "test": "testNormalResumeSplitsPauseGapAtAuthoritativeEpochStart",
        "before": "        let boundary = try timeline.nativeTime(capture.epochStartMs)",
        "after": "        let boundary = now()",
        "assertion": "Resume must end the old pause gap at the authoritative epoch start",
    }),
    ("MeetingCaptureHost.swift", {
        "name": "source-lost-ack-stop-reconciles-gap-boundary",
        "test": "testStopAfterLostSourceReplySplitsQueuedGapBeforeStatus",
        "before": "              capture.epoch > max(oldEpoch, timeline.sourceBoundaryEpoch) else { return }",
        "after": "              false else { return }",
        "assertion": "Lost source acknowledgment Stop must never report a gap across epochs",
    }),
]


def select(source, control):
    RUNNER.SOURCE = RUNNER.APP / "TrailMarker/Meetings" / source
    RUNNER.TEST_CLASS = TEST_CLASS
    RUNNER.CONTROLS = (control,)
    original = RUNNER.validate_sources()
    tests = (RUNNER.APP / "TrailMarkerTests" / f"{TEST_CLASS}.swift").read_text()
    body = tests.split(f"func {control['test']}()", 1)[1]
    body = re.split(r"\n    (?:private )?func ", body, maxsplit=1)[0]
    if f'"{control["assertion"]}"' not in body:
        raise RuntimeError(f"Named semantic assertion is missing from selected test: {control['name']}")
    return original


def self_test():
    RUNNER.TEST_CLASS = TEST_CLASS
    RUNNER.CONTROLS = ({"test": "fixture", "assertion": "XCTAssertNil failed"},)
    RUNNER.self_test()
    for _, control in CONTROLS:
        failure = {"testCaseName": f"{TEST_CLASS}.{control['test']}()",
                   "message": "XCTAssertEqual failed - " + control["assertion"]}
        negative = {"metrics": {"testsCount": "1", "testsFailedCount": "1"},
                    "issues": {"testFailureSummaries": [failure]}}
        RUNNER.verify_result(negative, 65, control, True)
        RUNNER.verify_result({"metrics": {"testsCount": "1"}, "issues": {}}, 0, control, False)
        invalid = [
            ({**negative, "issues": {"testFailureSummaries": [
                {**failure, "message": "XCTAssertEqual failed - unrelated assertion"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [
                {**failure, "message": "Compiler failure - " + control["assertion"]}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [failure,
                {**failure, "testCaseName": "Unrelated.test()"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [failure,
                {**failure, "message": "Failed to launch test host"}]}}, 65),
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
            raise RuntimeError("Source proof accepted an unrelated assertion, build/crash/empty run or wrong exit")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate anchors and named assertions without changing source")
    parser.add_argument("--self-test", action="store_true", help="Check fail-closed XCResult recognition portably")
    args = parser.parse_args()
    names = [control["name"] for _, control in CONTROLS]
    if len(names) != len(set(names)):
        raise RuntimeError("Source mutation names must be unique")
    for source, control in CONTROLS:
        select(source, control)
    self_test()
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} source anchors and semantic proof recognition. Native execution remains required.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-source-negative-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Native source evidence directory: {folder}", flush=True)
    for source, control in CONTROLS:
        original = select(source, control)
        RUNNER.run_control(control, original, folder)
    print("Source mutations failed named semantic assertions and passed after restoration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
