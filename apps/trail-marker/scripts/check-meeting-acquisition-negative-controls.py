#!/usr/bin/env python3
"""Hosted-Mac staged-acquisition controls; --check is portable anchor validation only.

Reuse the existing runner's strict semantic XCTest recognition, source restoration,
and restored-positive rerun. No synthetic result is reported as native proof.
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
SPEC = importlib.util.spec_from_file_location("meeting_voice_negative", HERE / "check-meeting-voice-negative-controls.py")
SHARED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHARED)
RUNNER = SHARED.RUNNER
MEETINGS = RUNNER.APP / "TrailMarker/Meetings"
CONTROLS = [
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "acquisition-overlapping-stop-keeps-retry",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testCancelledAcquisitionRetainsFailedCleanupUntilStopRetriesIt",
        "before": "        if cleanupInProgress { cleanupRetryRequested = true }",
        "after": "        // Mutation: lose a newer Stop behind the executing disposal.",
        "assertion": "Stop retry must survive an overlapping failed disposal",
    }),
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "acquisition-failed-retry-does-not-spin",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testOverlappingFailedCleanupRetryDoesNotSpinWithoutAnotherStop",
        "before": "let retry = failed && cleanupRetryRequested",
        "after": "let retry = failed",
        "assertion": "A failed coalesced cleanup retry must not retry itself without another Stop",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-quarantine-ignores-clock",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testReceiverQuarantineDiscardsUnknownSamplesAndClockWithoutLosingHardFaults",
        "before": "guard state.value == 1, host >= admittedAt.deadline else { return false }",
        "after": "guard state.value != 2 else { return false }",
        "assertion": "Quarantine must not retain unconfirmed sample clocks or drops",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-postcommit-cutoff",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testQuarantineIgnoresPCMAndDropClocksUntilCommitCutoff",
        "before": "guard state.value == 1, host >= admittedAt.deadline else { return false }",
        "after": "guard state.value == 1 else { return false }",
        "assertion": "Postcommit callbacks must not inherit quarantined or precommit sample clocks",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-cancel-prevents-second-source",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testBlockedStartupLeavesSnapshotServicePauseAndStopResponsive",
        "before": "guard active else { throw Aborted.cancelled }",
        "after": "_ = active // Mutation: continue after cancellation.",
        "assertion": "Cancellation must prevent acquisition of the second source",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-failed-handle-retention",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testFailedDisposalBlocksRestartUntilStopRetriesRetainedHandles",
        "before": "do { try device.stop(); devices[source] = nil } catch { failed = true }",
        "after": "do { try device.stop(); devices[source] = nil } catch { devices[source] = nil; failed = true }",
        "assertion": "Stop must retry the same failed handle",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-stale-ticket-identity",
        "source": MEETINGS / "MeetingCaptureRuntime.swift",
        "test": "testCancelledTicketCannotCommitOrCancelANewerAcquisition",
        "before": "guard let staged = acquisition, staged.ticket == ticket else { throw MeetingAudioFailure.invalidTransition }",
        "after": "guard let staged = acquisition else { throw MeetingAudioFailure.invalidTransition }",
        "assertion": "A stale ticket must never adopt a newer acquisition",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-old-evidence-before-paired-source",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testOldScopeFaultDuringStartStopsPairAndRetiresTailWithoutServiceTick",
        "before": "        if let oldFailure = previousEvidence.compactMap({ $0.failure }).first(where: { $0 != .sourceReconfigured }) {\n            throw oldFailure\n        }\n        if let failure { throw failure }",
        "after": "        if let failure { throw failure }",
        "assertion": "Old hard evidence must prevent starting the paired source",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-trusted-admission-deadline",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testCommitChecksTrustedDeadlineAfterDelayedMainQueueDelivery",
        "before": "guard at < min(deadline, lease.deadline), monotonicNow() < min(deadline, lease.deadline) else {",
        "after": "guard at < min(deadline, lease.deadline) else {",
        "assertion": "Trusted deadline must reject admission even when the caller supplies an earlier clock",
    }),
    ("MeetingCaptureAcquisitionTests", {
        "name": "acquisition-no-pcm-before-commit",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testReceiverQuarantineDiscardsUnknownSamplesAndClockWithoutLosingHardFaults",
        "before": "guard state.value == 1, host >= admittedAt.deadline else { return false }",
        "after": "buffer.setHostSourceVerificationPending(false) // Mutation: remove both quarantine barriers.",
        "assertion": "Quarantine must never read native PCM",
    }),
    ("MeetingRecoveryAcquisitionHostTests", {
        "name": "acquisition-never-blocks-host-controls",
        "source": MEETINGS / "MeetingCaptureAcquisition.swift",
        "test": "testLocalPauseReachesServerWhileAcquisitionRemainsBlocked",
        "before": "func start() { ownerQueue.async { self.acquire() } }",
        "after": "func start() { acquire() }",
        "assertion": "Pause must reach Moss before the device call returns",
    }),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    RUNNER.self_test()
    for test_class, control in CONTROLS:
        SHARED.select(test_class, control)
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} acquisition anchors. Native XCTest execution remains required.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-acquisition-negative-", dir=os.environ.get("RUNNER_TEMP")))
    for test_class, control in CONTROLS:
        original = SHARED.select(test_class, control)
        RUNNER.run_control(control, original, folder)
    print("Acquisition mutations failed named assertions and passed after source restoration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
