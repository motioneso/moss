#!/usr/bin/env python3
"""Hosted-Mac native Resume mutations; --check/--self-test are portable, not XCTest proof."""
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
LIFECYCLE = "MeetingHostLifecycleTests"
OUTBOX = "MeetingControlOutboxTests"
RESUME_TEST = "testNativeResumeWaitsForAuthoritativeStatusAndPreservesPausedObservation"
CONTROLS = [
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-source-change-pauses-accepted-intent", "test": "testSourceChangePausesAnAlreadyAcceptedResumeWithLostReply",
        "before": '        if let pending = controlOutbox.pending, pending.command == "record" {',
        "after": '        if let pending = controlOutbox.pending, false {',
        "assertion": "An accepted Resume must be followed by Pause after source change",
    }),
    ("MeetingControlOutbox.swift", OUTBOX, {
        "name": "resume-rejection-preserves-newer-stop", "test": "testDefinitiveResumeRejectionClearsOnlyThatIntentAndNeverStop",
        "before": '        guard pending?.command == "record", pending?.requestKey == requestKey else { return false }',
        "after": '        guard pending != nil else { return false }',
        "assertion": "A stale Resume rejection must preserve Stop",
    }),
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-source-change-cancels-intent", "test": "testSourceChangeCancelsQueuedResumeAndRequiresNewClick",
        "before": '        if let pending = controlOutbox.pending, pending.command == "record" {',
        "after": '        if let pending = controlOutbox.pending, false {',
        "assertion": "Source change must cancel queued Resume before transport",
    }),
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-definitive-rejection-requires-click", "test": "testRejectedResumeRequiresAnotherExplicitClickInsteadOfRetryingLater",
        "before": '                } else if body.command == "record", (error as? MeetingHostError) == .rejected {',
        "after": '                } else if false {',
        "assertion": "Definitive rejection must clear Resume intent",
    }),
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-status-applies-recording-fence", "test": RESUME_TEST,
        "before": '                if body.command != "record" {',
        "after": '                _ = self.fence.shouldStart(generation: reply.capture.generation, desired: reply.capture.desired)\n                if body.command != "record" {',
        "assertion": "Authoritative status must open exactly one resumed epoch",
    }),
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-previous-paused-observation", "test": RESUME_TEST,
        "before": '                if body.command != "record" {',
        "after": '                self.observed = .init(generation: reply.capture.generation, phase: "paused", errorCode: nil)\n                if body.command != "record" {',
        "assertion": "Resume must preserve the previous-generation paused observation",
    }),
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-disabled-unconfirmed-pause", "test": RESUME_TEST,
        "before": 'sourceChangeIntent == nil && phase == .paused && remote?.desired == "paused" && remote?.selection == choice &&\n            !timeline.epochs.isEmpty && !stoppedByUser && !cleanupBlocked && !gapCoverageIncomplete &&\n            controlOutbox.pending == nil && !controlInFlight && credential != nil &&',
        "after": 'phase == .paused && remote?.selection == choice &&\n            !timeline.epochs.isEmpty && !stoppedByUser && !cleanupBlocked && !gapCoverageIncomplete &&\n            credential != nil &&',
        "assertion": "Resume is disabled until server Pause acknowledgment",
    }),
    ("MeetingCaptureHost.swift", LIFECYCLE, {
        "name": "resume-queued-stop-dominance", "test": "testStopCancelsQueuedResumeBeforeTransportAndKeepsHardwareClosed",
        "before": '                guard body.command != "record" || self.controlOutbox.pending?.requestKey == body.requestKey else { return }',
        "after": '                // Mutation: send superseded Resume.',
        "assertion": "Stop must cancel queued Resume before transport",
    }),
    ("MeetingControlOutbox.swift", OUTBOX, {
        "name": "resume-no-newer-authority-rebase", "test": "testResumeNeverRebasesAcrossNewerPauseStopOrSource",
        "before": 'if request.command == "record", generation > request.expectedGeneration || !retainedSourceMatches {',
        "after": 'if false {',
        "assertion": "Newer authority must cancel Resume instead of minting another request",
    }),
    ("MeetingControlOutbox.swift", OUTBOX, {
        "name": "resume-pause-intent-dominance", "test": "testPendingPauseOrStopCannotBeOverriddenByResume",
        "before": ' || (command == "record" && pending != nil)',
        "after": '',
        "assertion": "Resume must not override pending Pause or Stop",
    }),
]


def select(source, test_class, control):
    RUNNER.SOURCE = RUNNER.APP / "TrailMarker/Meetings" / source
    RUNNER.TEST_CLASS = test_class
    RUNNER.CONTROLS = (control,)
    return RUNNER.validate_sources()


def self_test():
    for _, test_class, control in CONTROLS:
        RUNNER.TEST_CLASS = test_class
        failure = {"testCaseName": f"{test_class}.{control['test']}()",
                   "message": "XCTAssertEqual failed - " + control["assertion"]}
        result = {"metrics": {"testsCount": "1", "testsFailedCount": "1"},
                  "issues": {"testFailureSummaries": [failure]}}
        RUNNER.verify_result(result, 65, control, True)
        for message in ["XCTAssertEqual failed - unrelated", "Compiler failure - " + control["assertion"]]:
            bad = {**result, "issues": {"testFailureSummaries": [{**failure, "message": message}]}}
            try:
                RUNNER.verify_result(bad, 65, control, True)
            except RuntimeError:
                continue
            raise RuntimeError("Resume proof accepted an unrelated assertion or build failure")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    for source, test_class, control in CONTROLS:
        select(source, test_class, control)
    self_test()
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} Resume anchors and semantic proof recognition. Native execution remains required.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-resume-negative-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Native Resume evidence directory: {folder}", flush=True)
    for source, test_class, control in CONTROLS:
        original = select(source, test_class, control)
        RUNNER.run_control(control, original, folder)
    print("Resume mutations failed named semantic assertions and passed after restoration.")


if __name__ == "__main__":
    main()
