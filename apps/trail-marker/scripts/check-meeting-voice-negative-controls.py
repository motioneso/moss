#!/usr/bin/env python3
"""Hosted-Mac voice-processing mutations; portable checks are not native XCTest proof.

The real property writer, installed silent callback, and reference-route guard each
have a named behavioral assertion. Run after positive native tests in an isolated
Mac checkout. The shared runner restores source bytes and requires a positive rerun;
build failures, crashes, empty runs, and unrelated assertions are never proof.
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
SOURCE = RUNNER.APP / "TrailMarker/Meetings/MeetingVoiceProcessing.swift"
VOICE = "MeetingVoiceProcessingTests"
MICROPHONE = "MeetingMicrophoneCaptureTests"
CONTROLS = [
    (VOICE, {
        "name": "voice-minimum-other-audio-ducking",
        "test": "testAdvancedDuckingUsesMinimumLevel",
        "before": "mEnableAdvancedDucking: true, mDuckingLevel: .min)",
        "after": "mEnableAdvancedDucking: true, mDuckingLevel: .max)",
        "assertion": "Voice processing must request minimum other-audio ducking",
    }),
    (VOICE, {
        "name": "voice-zero-output-reference",
        "test": "testInstalledCallbackWritesSilenceWithoutPlayingCapturedAudio",
        "before": "        memset(data, 0, Int(frames) * MemoryLayout<Float>.size)",
        "after": "        _ = data // Mutation: advertise silence without clearing the audio buffer.",
        "assertion": "Playback reference must write zero bytes instead of replaying captured audio",
    }),
    (MICROPHONE, {
        "name": "voice-reference-route-admission",
        "test": "testReferenceRouteChangesCloseMicrophoneAdmissionWithoutRetargeting",
        "before": "        guard alive, current == expected else { context.deviceDidDisappear(); return }",
        "after": "        guard true else { context.deviceDidDisappear(); return }",
        "assertion": "Changed reference must close microphone admission",
    }),
]


def select(test_class, control):
    RUNNER.SOURCE = SOURCE
    RUNNER.TEST_CLASS = test_class
    RUNNER.CONTROLS = (control,)
    original = RUNNER.validate_sources()
    tests = (RUNNER.APP / "TrailMarkerTests" / f"{test_class}.swift").read_text()
    body = tests.split(f"func {control['test']}()", 1)[1]
    body = re.split(r"\n    (?:private )?func ", body, maxsplit=1)[0]
    if f'"{control["assertion"]}"' not in body:
        raise RuntimeError(f"Named semantic assertion is missing from selected test: {control['name']}")
    return original


def self_test():
    # Preserve all shared-runner recognition and invocation checks before checking
    # each additional semantic marker and both XCTest classes used by this runner.
    RUNNER.TEST_CLASS = VOICE
    RUNNER.CONTROLS = ({"test": "fixture", "assertion": "XCTAssertNil failed"},)
    RUNNER.self_test()
    for test_class, control in CONTROLS:
        RUNNER.TEST_CLASS = test_class
        failure = {"testCaseName": f"{test_class}.{control['test']}()",
                   "message": "XCTAssertEqual failed - " + control["assertion"]}
        negative = {"metrics": {"testsCount": "1", "testsFailedCount": "1"},
                    "issues": {"testFailureSummaries": [failure]}}
        RUNNER.verify_result(negative, 65, control, True)
        RUNNER.verify_result({"metrics": {"testsCount": "1"}, "issues": {}}, 0, control, False)
        typed = {"metrics": {"testsCount": {"_value": "1"}, "testsFailedCount": {"_value": "1"}},
                 "issues": {"testFailureSummaries": {"_values": [
                     {key: {"_value": value} for key, value in failure.items()}
                 ]}}}
        RUNNER.verify_result(typed, 65, control, True)
        invalid = [
            ({**negative, "issues": {"testFailureSummaries": [
                {**failure, "message": "XCTAssertEqual failed - unrelated assertion"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [
                {**failure, "message": "Compiler failure - " + control["assertion"]}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [
                {**failure, "message": "Test host crashed - " + control["assertion"]}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [
                {**failure, "testCaseName": "Unrelated.test()"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [failure,
                {**failure, "testCaseName": "Unrelated.test()"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [failure,
                {**failure, "message": "Failed to launch test host"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [failure],
                "errorSummaries": [{"message": "Compiler failure"}]}}, 65),
            ({**negative, "issues": {"testFailureSummaries": [failure],
                "analyzerWarningSummaries": [{"message": "Analyzer failure"}]}}, 65),
            ({**negative, "metrics": {"testsCount": "0", "testsFailedCount": "1"}}, 65),
            ({**negative, "metrics": {"testsCount": "2", "testsFailedCount": "1"}}, 65),
            ({**negative, "metrics": {"testsCount": "1", "testsFailedCount": "0"}}, 65),
            (negative, 0),
            (negative, 1),
        ]
        for result, code in invalid:
            try:
                RUNNER.verify_result(result, code, control, True)
            except RuntimeError:
                continue
            raise RuntimeError("Voice proof accepted an unrelated assertion, build/crash/empty run or wrong exit")
        for result, code in [(negative, 0), ({"metrics": {"testsCount": "0"}, "issues": {}}, 0),
                             ({"metrics": {"testsCount": "1"}, "issues": {}}, 65)]:
            try:
                RUNNER.verify_result(result, code, control, False)
            except RuntimeError:
                continue
            raise RuntimeError("Voice proof accepted an incomplete or failing restored run")
        args = RUNNER.xcodebuild_arguments(control, Path("fixture.xcresult"))
        selected = f"-only-testing:TrailMarkerTests/{test_class}/{control['test']}"
        if selected not in args:
            raise RuntimeError("Voice proof did not select the exact test class and method")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate source anchors and named assertions without mutation")
    parser.add_argument("--self-test", action="store_true", help="Check fail-closed XCResult recognition portably")
    args = parser.parse_args()
    names = [control["name"] for _, control in CONTROLS]
    if len(names) != len(set(names)):
        raise RuntimeError("Voice mutation names must be unique")
    for test_class, control in CONTROLS:
        select(test_class, control)
    self_test()
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} voice anchors and semantic proof recognition. Native execution remains required.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, RUNNER.interrupted)
    folder = Path(tempfile.mkdtemp(prefix="meeting-voice-negative-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Native voice evidence directory: {folder}", flush=True)
    for test_class, control in CONTROLS:
        original = select(test_class, control)
        RUNNER.run_control(control, original, folder)
    print("Voice mutations failed named semantic assertions and passed after byte-for-byte restoration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
