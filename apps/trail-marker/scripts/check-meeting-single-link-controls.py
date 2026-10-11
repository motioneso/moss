#!/usr/bin/env python3
"""Exact approved-proof recovery guard-removal tests for the hosted Mac build.

All selected tests use isolated synthetic identities/transports. --check/--self-test
validate anchors and result matching only; native execution remains required.
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
    [
        "App/ConnectionRuntime.swift",
        "RecordingCapabilityRecoveryTests",
        {
            "name": "T13-approved-recovery-policy",
            "test": "testApprovedStatusRejectsInvalidPolicyOrRevisionWithoutReplacingCandidate",
            "before": "            guard reply.policyVersion == 1, (reply.revision ?? 0) > 0 else { throw MeetingHostError.invalidResponse }",
            "after": "            guard (reply.revision ?? 0) > 0 else { throw MeetingHostError.invalidResponse }",
            "assertion": "XCTAssertTrue failed"
        }
    ],
    [
        "App/ConnectionRuntime.swift",
        "RecordingCapabilityRecoveryTests",
        {
            "name": "T13-approved-recovery-revision",
            "test": "testApprovedStatusRejectsInvalidPolicyOrRevisionWithoutReplacingCandidate",
            "before": "            guard reply.policyVersion == 1, (reply.revision ?? 0) > 0 else { throw MeetingHostError.invalidResponse }",
            "after": "            guard reply.policyVersion == 1 else { throw MeetingHostError.invalidResponse }",
            "assertion": "XCTAssertTrue failed"
        }
    ],
    [
        "App/ConnectionRuntime.swift",
        "RecordingCapabilityRecoveryTests",
        {
            "name": "T13-cancelled-recovery-inert",
            "test": "testCancelledRecoveryIgnoresLateApprovalOrExpiry",
            "before": "        guard identity == expectedIdentity, !Task.isCancelled, requestClient() != nil else { return \"cancelled\" }",
            "after": "        guard identity == expectedIdentity, requestClient() != nil else { return \"cancelled\" }",
            "assertion": "XCTAssertEqual failed"
        }
    ],
    [
        "App/ConnectionRuntime.swift",
        "RecordingCapabilityRecoveryTests",
        {
            "name": "T13-disconnected-recovery-inert",
            "test": "testDisconnectedRuntimeIgnoresLateApproval",
            "before": "        guard identity == expectedIdentity, !Task.isCancelled, requestClient() != nil else { return \"cancelled\" }",
            "after": "        guard identity == expectedIdentity, !Task.isCancelled else { return \"cancelled\" }",
            "assertion": "XCTAssertEqual failed"
        }
    ],
    [
        "App/ConnectionRuntime.swift",
        "RecordingCapabilityRecoveryTests",
        {
            "name": "T13-approved-recovery-same-proof",
            "test": "testLostApprovalResponseThenOfflineBeyondAttemptDeadlineRecoversSameProof",
            "before": "            try storeRecordingProof(pending.proof, for: expectedIdentity)",
            "after": "            try storeRecordingProof(String(repeating: \"x\", count: 43), for: expectedIdentity)",
            "assertion": "XCTAssertEqual failed"
        }
    ]
]


def select(source, test_class, control):
    RUNNER.SOURCE = RUNNER.APP / "TrailMarker" / source
    RUNNER.TEST_CLASS = test_class
    RUNNER.CONTROLS = (control,)
    return RUNNER.validate_sources()


def recovery_self_test():
    for _, test_class, control in CONTROLS:
        if test_class != "RecordingCapabilityRecoveryTests":
            continue
        RUNNER.TEST_CLASS = test_class
        failure = {
            "testCaseName": f"{test_class}.{control['test']}()",
            "message": f"{control['assertion']}: synthetic recovery mutation",
        }
        negative = {"metrics": {"testsCount": "1", "testsFailedCount": "1"},
                    "issues": {"testFailureSummaries": [failure]}}
        RUNNER.verify_result(negative, 65, control, True)
        RUNNER.verify_result({"metrics": {"testsCount": "1"}, "issues": {}}, 0, control, False)
        for message in ["failed - Approval was accepted", "Test threw an unexpected error",
                        "XCTAssertGreaterThan failed: unrelated assertion"]:
            invalid = {**negative, "issues": {"testFailureSummaries": [{**failure, "message": message}]}}
            try:
                RUNNER.verify_result(invalid, 65, control, True)
            except RuntimeError:
                continue
            raise RuntimeError(f"Recovery matcher accepted an unrelated or non-assertion failure: {control['name']}")
    print("Recovery assertion matchers validated; hosted mutation/restoration evidence remains required.")



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    for source, test_class, control in CONTROLS:
        select(source, test_class, control)
    recovery_self_test()
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} recovery anchors; no native security proof executed.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in an isolated hosted Mac checkout; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-single-link-negative-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Native recovery evidence directory: {folder}", flush=True)
    for source, test_class, control in CONTROLS:
        original = select(source, test_class, control)
        RUNNER.run_control(control, original, folder)
    print("Recovery guard removals failed named assertions and passed after restoration.")


if __name__ == "__main__":
    main()
