#!/usr/bin/env python3
"""Database-free guard-removal proof for single-link approval and exact-proof recovery.

Each mutation must fail its named behavioral assertion, then pass after byte-for-byte
restoration. --check and --self-test do not execute guard-removal proof. No DB or native
hardware is used. Run in an isolated checkout, never while another worker tests it.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
UNIT = "tests/unit/recording-capabilities.test.ts"
AUTH = "packages/auth/src/recording-capabilities.ts"


def mutation(path, before, after):
    return (path, before, after)


def control(name, test, edits, suite=UNIT, marker=""):
    return {"name": name, "test": test, "edits": edits, "suite": suite, "marker": marker}


CONTROLS = [
    control("single-link-no-second-attempt", "retires the separate attempt", [
        mutation("apps/api/src/companion-recording-routes.ts",
            '        await auth.companionDevices.resolve({\n          headers: request.headers,\n          requestId: request.id\n        });\n        // A linked device cannot open a second recording-approval flow.\n        return reply.code(410).send({ code: "recording_relink_required" });',
            '        const actor = await auth.companionDevices.resolve({ headers: request.headers, requestId: request.id });\n        return await service.createAttempt(actor, request.body);')
    ], "tests/unit/recording-capabilities.test.ts"),
    control("single-link-no-second-decision", "retires the separate decision", [
        mutation("apps/api/src/companion-recording-routes.ts",
            '        await browser(request, true);\n        // Only versioned initial pairing may create new recording authority.\n        return reply.code(410).send({ code: "recording_relink_required" });',
            '        const actor = await browser(request, true);\n        return await service.decide(actor, request.body);')
    ], "tests/unit/recording-capabilities.test.ts"),
    control("independent-proof", "requires independent proof", [mutation(AUTH,
        'if (!digestsMatch(digest(proof), row.proof_hash)) throw new RecordingCapabilityError();',
        'if (false) throw new RecordingCapabilityError();')]),
    control("cookie-mixing", "rejects cookie mixing", [mutation(AUTH,
        'if (headers.cookie || typeof proof !== "string"', 'if (typeof proof !== "string"')]),
    control("live-revision", "never restores old authority", [mutation(AUTH,
        'if (row.revision !== input.capabilityRevision) throw new RecordingCapabilityError();',
        'if (false) throw new RecordingCapabilityError();')]),
    control("recovery-revision", "does not recover a candidate after its approved revision is replaced", [mutation(AUTH,
        'active.revision !== row.approved_revision ||', 'false ||')]),
    control("recovery-proof", "does not recover a different proof at the same revision", [mutation(AUTH,
        '!digestsMatch(active.proof_hash, row.proof_hash)', 'false')]),
    control("recovery-device", "does not recover without a live device", [mutation(AUTH,
        '      await liveDevice(pool, actor);', '      void actor;')]),
    control("recovery-pending", "never approves a pending or denied legacy candidate", [mutation(AUTH,
        'status: expired ? "expired" : row.status,', 'status: expired ? "expired" : "approved",')])
]

FAILURE_PATTERNS = {
    "single-link-no-second-attempt": r"expected 200 to be 410",
    "single-link-no-second-decision": r"expected 200 to be 410",
    **{name: r"^Error: promise resolved .* instead of rejecting" for name in [
        "independent-proof", "cookie-mixing", "live-revision", "recovery-device"]},
    "recovery-revision": r"^AssertionError: recovery-revision: expected 'approved' to be 'expired'",
    "recovery-proof": r"^AssertionError: recovery-proof: expected 'approved' to be 'expired'",
    "recovery-pending": r"^AssertionError: recovery-pending: expected 'approved' to be 'pending'"
}

def validate(controls):
    for item in controls:
        for relative, before, _after in item["edits"]:
            count = (ROOT / relative).read_text().count(before)
            if count != 1:
                raise RuntimeError(f'{item["name"]}: expected one source anchor in {relative}, found {count}')


def assertions(report):
    return [test for suite in report.get("testResults", []) for test in suite.get("assertionResults", [])]


def run_test(item, path):
    output = path.with_suffix(".log")
    runtime = path.with_suffix(".runtime.json")
    with output.open("w") as log:
        result = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", item["suite"],
            "-t", item["test"], "--reporter=json",
            "--reporter=./scripts/meeting-proof-runtime-reporter.ts", f"--outputFile={path}"], cwd=ROOT,
            env={**os.environ, "MOSS_PROOF_RUNTIME_REPORT": str(runtime)},
            stdout=log, stderr=subprocess.STDOUT, timeout=600)
    if not path.exists():
        raise RuntimeError(f'{item["name"]}: no assertion report; inspect {output}')
    report = json.loads(path.read_text())
    runtime_report = json.loads(runtime.read_text())
    if (runtime_report.get("schemaVersion") != 1
            or runtime_report.get("reason") not in ("passed", "failed")
            or runtime_report.get("moduleCount") != 1
            or runtime_report.get("unhandledErrors") != 0
            or runtime_report.get("collectionErrors") != 0):
        raise RuntimeError(f'{item["name"]}: runtime/collection error or incomplete run; inspect {output}')
    executed = [test for test in assertions(report) if test.get("status") in ("passed", "failed")]
    matching = [test for test in executed if re.search(item["test"], test.get("fullName", ""))]
    failed = [test for test in executed if test["status"] == "failed"]
    if (len(matching) != 1 or len(executed) != 1
            or report.get("numFailedTests") != len(failed)
            or result.returncode not in (0, 1)
            or report.get("success") is not (result.returncode == 0)):
        raise RuntimeError(f'{item["name"]}: wrong test selection or runtime/harness error; inspect {output}')
    return result.returncode, matching, output


def expected_assertion(item, failure):
    is_assertion = "AssertionError" in failure or (failure.startswith("Error: promise resolved ") and "__VITEST_REJECTS__" in failure)
    return bool(is_assertion and re.search(FAILURE_PATTERNS[item["name"]], failure, re.S)
                and (not item["marker"] or item["marker"] in failure))


def run_control(item, directory):
    originals = {path: (ROOT / path).read_bytes() for path, _, _ in item["edits"]}
    try:
        for path, before, after in item["edits"]:
            file = ROOT / path
            file.write_text(file.read_text().replace(before, after, 1))
        code, tests, output = run_test(item, directory / (item["name"] + "-red.json"))
        failures = [test for test in tests if test["status"] == "failed"]
        if code != 1 or len(failures) != 1:
            raise RuntimeError(f'{item["name"]}: mutation did not fail its named assertion; inspect {output}')
        for test in failures:
            messages = test.get("failureMessages", [])
            failure = messages[0] if len(messages) == 1 else ""
            if not expected_assertion(item, failure):
                raise RuntimeError(f'{item["name"]}: wrong failure (not the intended assertion); inspect {output}')
    finally:
        for path, contents in originals.items():
            (ROOT / path).write_bytes(contents)
            if (ROOT / path).read_bytes() != contents:
                raise RuntimeError(f"Source restoration failed: {path}")
    code, tests, output = run_test(item, directory / (item["name"] + "-green.json"))
    if code != 0 or any(test["status"] != "passed" for test in tests):
        raise RuntimeError(f'{item["name"]}: restored source is not green; inspect {output}')
    print(f'{item["name"]}: named assertion RED; restored GREEN', flush=True)



def self_test():
    item = CONTROLS[0]
    expected = "AssertionError: expected 200 to be 410 // Object.is equality"
    if not expected_assertion(item, expected):
        raise RuntimeError("The retired-route assertion was not recognized")
    for name in ["recovery-revision", "recovery-proof", "recovery-pending"]:
        item = next(control for control in CONTROLS if control["name"] == name)
        status = "pending" if name == "recovery-pending" else "expired"
        expected = f"AssertionError: {name}: expected 'approved' to be '{status}'"
        if not expected_assertion(item, expected):
            raise RuntimeError("The recovery assertion was not recognized")
        for invalid in [expected.replace("AssertionError", "TypeError"),
                        expected.replace("'approved'", "'denied'"),
                        expected.replace(f"{name}: ", "")]:
            if expected_assertion(item, invalid):
                raise RuntimeError("An unrelated recovery failure was accepted as proof")
    item = CONTROLS[0]
    for invalid in ["TypeError: expected 200 to be 410", "Error: expected 200 to be 410",
                    "AssertionError: expected 500 to be 410", "Compiler failure", "Test host crashed"]:
        if expected_assertion(item, invalid):
            raise RuntimeError("A build, setup, or unrelated failure was accepted as proof")


def interrupted(_signal, _frame):
    raise KeyboardInterrupt("Interrupted; restoring mutation sources")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--unit", action="store_true")
    args = parser.parse_args()
    self_test()
    validate(CONTROLS)
    if args.check or args.self_test:
        print(f"Validated {len(CONTROLS)} source anchors and fail-closed matcher; no security proof executed.")
        return
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    directory = Path(tempfile.mkdtemp(prefix="meeting-single-link-negative-"))
    print(f"Proof receipts: {directory}", flush=True)
    for item in CONTROLS:
        run_control(item, directory)
    print("All named unit assertions failed under mutation and passed after restoration.")
    print("Database-free evidence only; hosted database and native proof remain separate.")


if __name__ == "__main__":
    main()
