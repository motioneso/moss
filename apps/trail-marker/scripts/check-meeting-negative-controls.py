#!/usr/bin/env python3
"""Prove native audio guards with synthetic XCTest negative controls.

Run only in an isolated macOS CI checkout after its normal positive tests. No
capture adapter or permission flow is instantiated by the selected tests. Each
mutation changes one exact anchor, restores the original bytes in finally, and
requires a named XCTest assertion failure, not merely a nonzero xcodebuild exit.
--check and --self-test are read-only/portable checks, not native proof.
"""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


APP = Path(__file__).resolve().parents[1]
SOURCE = APP / "TrailMarker/Meetings/MeetingAudioBuffer.swift"
TEST_CLASS = "MeetingAudioBufferTests"
CONTROLS = (
    {
        "name": "closed-callback-admission",
        "test": "testPauseClosesAdmissionWithoutDiscardingPrePauseAudio",
        "before": "    func close() {\n        closed.insert(1)\n        lock.lock()\n        accepting = false\n        lock.unlock()\n    }",
        "after": "    func close() {}",
        "assertion": "XCTAssertNil failed",
    },
    {
        "name": "pre-cutoff-samples-only",
        "test": "testPartialStopUsesOnlyWholeSamplesAtOrBeforeCutoff",
        "before": "peekChunk(targetDurationNanoseconds: nil, cutoffNanoseconds: cutoffNanoseconds,",
        "after": "peekChunk(targetDurationNanoseconds: nil, cutoffNanoseconds: nil,",
        "assertion": "XCTAssertNil failed",
    },
    {
        "name": "hardware-sample-continuity",
        "test": "testUnknownHardwareSampleGapOrRepeatNeverBecomesInventedContinuity",
        "before": "guard nextSampleTime.map({ sampleTime == $0 }) ?? true,",
        "after": "guard true,",
        "assertion": "XCTAssertEqual failed",
    },
    {
        "name": "finite-capture-lease",
        "test": "testCaptureLeaseClosesAdmissionWithoutWaitingForControlThread",
        "before": "guard host + duration <= deadline, clockOrigin + endOffset <= deadline else {",
        "after": "guard host <= UInt64.max else {",
        "assertion": "XCTAssertFalse failed",
    },
)


def unwrap(value):
    """Read the typed XCResult v3 object format without accepting missing fields."""
    if isinstance(value, list):
        return [unwrap(item) for item in value]
    if not isinstance(value, dict):
        return value
    if "_value" in value:
        return value["_value"]
    if "_values" in value:
        return [unwrap(item) for item in value["_values"]]
    return {key: unwrap(item) for key, item in value.items() if key != "_type"}


def verify_result(result, exit_code, control, negative):
    root = unwrap(result)
    metrics = root.get("metrics", {})
    issues = root.get("issues", {})
    failures = issues.get("testFailureSummaries", [])
    if issues.get("errorSummaries") or issues.get("analyzerWarningSummaries"):
        raise RuntimeError("Build/analyzer errors are not a meaningful negative control")
    if int(metrics.get("testsCount", -1)) != 1:
        raise RuntimeError("Expected exactly one executed XCTest; empty/partial runs are not proof")
    failed_count = int(metrics.get("testsFailedCount", 0))
    if not negative:
        if exit_code != 0 or failed_count != 0 or failures:
            raise RuntimeError("The restored source did not pass its targeted positive test")
        return
    if exit_code != 65 or failed_count != 1 or not failures:
        raise RuntimeError("Mutation must produce exactly one failed XCTest and xcodebuild exit 65")
    for failure in failures:
        name = failure.get("testCaseName", "")
        if TEST_CLASS not in name or control["test"] not in name:
            raise RuntimeError("An unrelated test failure is not proof of the selected guard")
        if "XCTAssert" not in failure.get("message", ""):
            raise RuntimeError("A crash, thrown error or harness failure is not assertion proof")
    if not any(control["assertion"] in failure.get("message", "") for failure in failures):
        raise RuntimeError("Expected guard-specific assertion failure was not recorded")


def validate_sources():
    original = SOURCE.read_bytes()
    text = original.decode("utf-8")
    tests = (APP / f"TrailMarkerTests/{TEST_CLASS}.swift").read_text()
    host = (APP / "TrailMarker/App/AppDelegate.swift").read_text()
    startup_guard = 'if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }'
    if startup_guard not in host:
        raise RuntimeError("Review test-host startup isolation before running native negative controls")
    for control in CONTROLS:
        if text.count(control["before"]) != 1:
            raise RuntimeError(f"Mutation anchor must occur exactly once: {control['name']}")
        if tests.count(f"func {control['test']}()") != 1:
            raise RuntimeError(f"Exact synthetic XCTest is missing/ambiguous: {control['test']}")
    return original


def stop_process_group(process):
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)


def xcodebuild_arguments(control, bundle):
    # Match the workflow's proven positive invocation. Python bounds the whole run;
    # XCTest timeout/repetition overrides can reject the scheme before any test executes
    # (for example, an explicit maximum smaller than the plan's default allowance).
    return [
        "xcodebuild", "test", "-scheme", "TrailMarker",
        "-destination", "platform=macOS",
        f"-only-testing:TrailMarkerTests/{TEST_CLASS}/{control['test']}",
        "-resultBundleVersion", "3", "-resultBundlePath", str(bundle),
    ]


def print_diagnostics(folder, control, label, result=None, exit_code=None):
    print(f"DIAGNOSTICS {control['name']} {label}: xcodebuild exit={exit_code}", flush=True)
    if result is not None:
        root = unwrap(result)
        print(json.dumps({"metrics": root.get("metrics"), "issues": root.get("issues")},
                         ensure_ascii=True)[:6000], flush=True)
    log = folder / f"{control['name']}-{label}.log"
    if log.is_file():
        print("Inner xcodebuild log (last 60 lines):", flush=True)
        print("\n".join(log.read_text(errors="replace").splitlines()[-60:])[-16000:], flush=True)


def run_test(control, folder, label):
    bundle = folder / f"{control['name']}-{label}.xcresult"
    log = folder / f"{control['name']}-{label}.log"
    args = xcodebuild_arguments(control, bundle)
    print(f"Running {label}: {TEST_CLASS}.{control['test']}", flush=True)
    with log.open("wb") as output:
        process = subprocess.Popen(args, cwd=APP, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            code = process.wait(timeout=300)
        except BaseException:
            stop_process_group(process)
            raise
    print(f"xcodebuild {label} exit: {code}", flush=True)
    if not bundle.is_dir():
        print_diagnostics(folder, control, label, exit_code=code)
        raise RuntimeError(f"No XCResult bundle; inspect {log.name}. Exit: {code}")
    extracted = subprocess.run(
        ["xcrun", "xcresulttool", "get", "object", "--legacy", "--path", str(bundle), "--format", "json"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    result = json.loads(extracted.stdout)
    (folder / f"{control['name']}-{label}.json").write_text(json.dumps(result, indent=2) + "\n")
    try:
        verify_result(result, code, control, negative=label == "mutated")
    except Exception:
        print_diagnostics(folder, control, label, result=result, exit_code=code)
        raise
    return code, result


def run_control(control, original, folder):
    mutated = original.decode("utf-8").replace(control["before"], control["after"], 1).encode("utf-8")
    problem = None
    try:
        if SOURCE.read_bytes() != original:
            raise RuntimeError("Source changed since validation; do not mutate a shared working tree")
        SOURCE.write_bytes(mutated)
        _, result = run_test(control, folder, "mutated")
        print(f"NEGATIVE VERIFIED: {control['name']} failed its named {control['assertion']}", flush=True)
        for failure in unwrap(result).get("issues", {}).get("testFailureSummaries", [])[:3]:
            print(f"  {failure['testCaseName']}: {failure['message'][:500]}", flush=True)
    except Exception as error:
        problem = error
        print(f"MUTATED RUN REJECTED: {control['name']}: {error}", flush=True)
    finally:
        SOURCE.write_bytes(original)
        if SOURCE.read_bytes() != original:
            raise RuntimeError("Failed to restore original source bytes")
    # A failed mutation/build is never converted into success by this restored pass.
    try:
        run_test(control, folder, "restored")
    except Exception as error:
        if problem is not None:
            raise RuntimeError(f"Mutated run: {problem}; restored run: {error}") from error
        raise
    print(f"RESTORED VERIFIED: {control['name']} passed", flush=True)
    if problem is not None:
        raise problem


def self_test():
    control = CONTROLS[0]
    failure = {
        "testCaseName": f"-[TrailMarkerTests.{TEST_CLASS} {control['test']}]",
        "message": "XCTAssertNil failed: synthetic callback remained pending",
    }
    negative = {"metrics": {"testsCount": "1", "testsFailedCount": "1"},
                "issues": {"testFailureSummaries": [failure]}}
    verify_result(negative, 65, control, True)
    verify_result({"metrics": {"testsCount": "1"}, "issues": {}}, 0, control, False)
    invalid = [
        ({"metrics": {"testsCount": "0"}, "issues": {}}, 65),
        ({**negative, "issues": {"errorSummaries": [{"message": "Compiler failure"}]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [{**failure, "message": "Test host crashed"}]}}, 65),
        ({**negative, "issues": {"testFailureSummaries": [{**failure, "testCaseName": "Unrelated.test"}]}}, 65),
        (negative, 0),
    ]
    for result, code in invalid:
        try:
            verify_result(result, code, control, True)
        except RuntimeError:
            continue
        raise RuntimeError("Harness accepted a compile/crash/empty/unrelated/surviving result")
    typed = {"metrics": {"testsCount": {"_value": "1"}, "testsFailedCount": {"_value": "1"}},
             "issues": {"testFailureSummaries": {"_values": [
                 {key: {"_value": value} for key, value in failure.items()}
             ]}}}
    verify_result(typed, 65, control, True)
    args = xcodebuild_arguments(control, Path("fixture.xcresult"))
    if args[:4] != ["xcodebuild", "test", "-scheme", "TrailMarker"]:
        raise RuntimeError("Negative controls must use the same scheme/action as positive CI")
    unsupported_overrides = {"-test-iterations", "-test-timeouts-enabled",
                             "-maximum-test-execution-time-allowance"}
    if unsupported_overrides.intersection(args):
        raise RuntimeError("Do not reintroduce unvalidated timeout/repetition overrides")
    print("Portable harness self-test passed; this is not native XCTest evidence.")


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate exact anchors without writing or running Xcode")
    parser.add_argument("--self-test", action="store_true", help="Test rejection of non-XCTest failures portably")
    args = parser.parse_args()
    original = validate_sources()
    if args.self_test:
        self_test()
    if args.check or args.self_test:
        print("Exact mutation anchors, synthetic tests, and test-host startup guard verified.")
        return
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Run mutations only in the isolated hosted Mac workflow; use --check locally")
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    # Keep XCResult/log evidence in the runner's temporary directory, outside the checkout.
    folder = Path(tempfile.mkdtemp(prefix="meeting-negative-controls-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Negative-control evidence directory: {folder}", flush=True)
    try:
        for control in CONTROLS:
            run_control(control, original, folder)
    finally:
        SOURCE.write_bytes(original)
    print("All native negative controls failed meaningfully and passed after byte-for-byte restoration.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
