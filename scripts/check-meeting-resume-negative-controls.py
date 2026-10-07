#!/usr/bin/env python3
"""Database-free native Resume guard-removal proofs; use --check for anchors only."""
import argparse
import importlib.util
from pathlib import Path
import signal
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("meeting_single_link_negative", HERE / "check-meeting-single-link-controls.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)
SUITE = "tests/unit/meeting-native-resume.test.ts"
SERVICE = "packages/meetings/src/capture-service.ts"
CONTROLS = [
    RUNNER.control("resume-active-grant-only", "denies finalizing without creating or renewing native recording authority", [
        RUNNER.mutation(SERVICE, '(grant.status !== "active" ||', '(false ||')
    ], SUITE),
    RUNNER.control("resume-paused-only", "denies native initial Start even with an active claimed credential", [
        RUNNER.mutation(SERVICE, '            state.desired !== "paused" ||', '            false ||')
    ], SUITE),
    RUNNER.control("resume-fenced-state", "checks the paused-only guard inside the auth-fenced transaction", [
        RUNNER.mutation(SERVICE, '            state.desired !== "paused" ||', '            false ||')
    ], SUITE),
    RUNNER.control("resume-no-selection-replay", "rejects explicit selection at native record ingress", [
        RUNNER.mutation(SERVICE, 'if (!["pause", "stop", "record"].includes(input.command) || input.selection !== undefined)',
                        'if (!["pause", "stop", "record"].includes(input.command))')
    ], SUITE),
    RUNNER.control("resume-native-command-scope", "rejects native revoke even with a committed receipt", [
        RUNNER.mutation(SERVICE, '!["pause", "stop", "record"].includes(input.command)', 'false')
    ], SUITE),
    RUNNER.control("resume-exact-generation", "requires the exact paused generation", [
        RUNNER.mutation("packages/meetings/src/capture-domain.ts", 'if (input.expectedGeneration !== state.generation)', 'if (false)')
    ], SUITE),
]
for item in CONTROLS:
    RUNNER.FAILURE_PATTERNS[item["name"]] = r"^Error: promise resolved .* instead of rejecting"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--unit", action="store_true")
    args = parser.parse_args()
    RUNNER.self_test()
    RUNNER.validate(CONTROLS)
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} Resume mutation anchors; no security proof executed.")
        return
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, RUNNER.interrupted)
    directory = Path(tempfile.mkdtemp(prefix="meeting-resume-negative-"))
    print(f"Proof receipts: {directory}", flush=True)
    for item in CONTROLS:
        RUNNER.run_control(item, directory)
    print("Native Resume service guards failed their named assertions and passed after byte-for-byte restoration.")


if __name__ == "__main__":
    main()
