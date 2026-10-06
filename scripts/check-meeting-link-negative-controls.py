#!/usr/bin/env python3
"""Fail-closed Mac link guard-removal proof runner.

--unit executes database-free behavioral tests. --hosted is only for the canonical
isolated verify gate. --check validates source anchors without executing security proof.
A named assertion must fail under each mutation; compile/import/setup failures do not count.
Every source is restored byte-for-byte before its green run, including on interruption.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
UNIT = "tests/unit/meeting-link-security.test.ts"
OWNED = "packages/db/src/owned-pg-client.ts"
INTEGRATION = "tests/integration/meeting-link-security.test.ts"
FENCE = "packages/auth/src/capture-binding.ts"
BUDGET = "packages/meetings/src/capture-start-limiter.ts"
CAPABILITY = "packages/auth/src/recording-capabilities.ts"
SERVICE = "packages/meetings/src/capture-service.ts"
BINDING = "packages/meetings/src/capture-binding.ts"
CONNECTION = "packages/meetings/src/capture-connection-service.ts"
AUTH_SESSION = "packages/auth/src/session-bindings.ts"
LOGGER = "apps/api/src/recording-logger-options.ts"


def mutation(path, before, after):
    return (path, before, after)


def control(name, test, edits, suite=UNIT, marker=""):
    return {"name": name, "test": test, "edits": edits, "suite": suite, "marker": marker}


UNIT_CONTROLS = [
    control("R3-owned-connect-bridge", "settles a stalled connect explicitly", [
        mutation(OWNED, "rejectConnect?.(signal.reason);", "void signal.reason;")
    ], "tests/unit/owned-pg-client.test.ts", "owned-connect-settled-after-close"),
    control("R3-owned-idle-destroy", "force-closes even a successful idle", [
        mutation(OWNED, "socket.destroy();", "void socket;")
    ], "tests/unit/owned-pg-client.test.ts", "owned-idle-forced-close"),
    control("R3-owned-query-abort", "aborting a DataContext query", [
        mutation(OWNED, 'signal.addEventListener("abort", abort, { once: true });', "void abort;")
    ], "tests/unit/owned-pg-client.test.ts", "owned-transaction-settled-after-abort"),
    control("T1-T2-missing-device-fence", "rejects absent companion_devices", [
        mutation(FENCE, 'if (!device.rows.length) throw new SessionBindingError("device-unavailable");', 'if (false) throw new SessionBindingError("device-unavailable");')]),
    control("T3-missing-capability-fence", "rejects absent companion_recording_capabilities", [
        mutation(FENCE, 'if (!capability.rows.length) throw new RecordingCapabilityError();', 'if (false) throw new RecordingCapabilityError();')]),
    control("T4-missing-session-fence", "rejects absent better_auth_sessions", [
        mutation(FENCE, '!user.rows.length || !session.rows.length', '!user.rows.length || false')]),
    control("T5-post-fence-deadline", "rechecks the grant deadline after waiting", [
        mutation(BINDING, 'if (protect && grant.expires_at <= (deps.now ?? (() => new Date()))())', 'if (false)')]),
    control("T10-minute-budget", "refuses the eleventh rolling-minute", [
        mutation(BUDGET, 'minute.length >= 10 ?', 'false ?')]),
    control("T10-hour-budget", "independently refuses the sixty-first hourly", [
        mutation(BUDGET, 'recent.length >= 60 ?', 'false ?')]),
    control("T11-log-redaction", "redacts every recording bearer/header/body secret", [
        mutation(LOGGER, 'paths: [...new Set([...paths, ...recordingSecretPaths])]', 'paths: [...paths]')])
]

# Deleting a device also cascades its capability. These complementary Unlink mutations
# disable the actual DELETE, not just one of several redundant device-liveness checks.
HOSTED_CONTROLS = [
    control("T1-settings-unlink-delete", "T1/T2 settings Unlink", [mutation(
        "packages/auth/src/session-service.ts", '"DELETE FROM app.companion_devices WHERE id = $1 AND user_id = $2"',
        '"SELECT id FROM app.companion_devices WHERE id = $1 AND user_id = $2"')], INTEGRATION, "link-status-denial:device-unavailable"),
    control("T2-native-logout-delete", "T1/T2 mac Unlink", [mutation(
        "packages/auth/src/companion-devices.ts", '"DELETE FROM app.companion_devices WHERE credential_hash = $1"',
        '"SELECT id FROM app.companion_devices WHERE credential_hash = $1"')], INTEGRATION, "link-status-denial:device-unavailable"),
    control("T3-capability-revoke", "T3 recording-only revoke", [
        mutation(CAPABILITY, 'AND c.revoked_at IS NULL AND c.policy_version=1', 'AND c.policy_version=1'),
        mutation(CAPABILITY, 'if (row.revision !== input.capabilityRevision) throw new RecordingCapabilityError();', 'if (false) throw new RecordingCapabilityError();'),
        mutation(FENCE, 'AND revision=$3 AND revoked_at IS NULL AND policy_version=1', 'AND $3::int>0 AND policy_version=1')
    ], INTEGRATION, "link-status-denial:recording-permission-revoked"),
    control("T4-session-binding", "T4 local sign-out", [
        mutation(AUTH_SESSION, 'if (!row) throw unavailable();', 'if (false) throw unavailable();'),
        mutation(FENCE, '!user.rows.length || !session.rows.length', '!user.rows.length || false')
    ], INTEGRATION, "link-status-denial:session-ended"),
    control("T5-claim-deadline", "T5 refuses a claim after 60 seconds", [
        mutation(CONNECTION, 'grant.status !== "approved" ||\n            !grant.claim_expires_at ||\n            grant.claim_expires_at <= this.now()', 'grant.status !== "approved"')
    ], INTEGRATION),
    control("T5-capture-lease", "T5 refuses audio after only the 30 second", [
        mutation("packages/meetings/src/capture-domain.ts", '!state.lastSeenAt ||\n      at.getTime() - Date.parse(state.lastSeenAt) > MEETING_CAPTURE_LEASE_MS)', '!state.lastSeenAt)')
    ], INTEGRATION),
    control("T5-hard-cap", "T5 refuses audio after only the 2 hour", [
        mutation(SERVICE, '      grant.expires_at <= this.now() ||\n', ''),
        mutation(BINDING, 'if (protect && grant.expires_at <= (deps.now ?? (() => new Date()))())', 'if (false)')
    ], INTEGRATION),
    control("T6-auth-device-owner", "T6 real auth device lookup rejects", [
        mutation(AUTH_SESSION, "WHERE d.id=$1 AND d.user_id=$2 AND d.expires_at>$3 AND d.absolute_expires_at>$3 AND u.status='active'",
            "WHERE d.id=$1 AND $2::uuid IS NOT NULL AND d.expires_at>$3 AND d.absolute_expires_at>$3 AND u.status='active'")
    ], INTEGRATION),
    control("T7-start-fingerprint", "T7 fences changed Start bodies", [
        mutation(CONNECTION, 'previous.start_fingerprint !== fingerprint ||\n', '')
    ], INTEGRATION),
    control("T7-connection-verifier", "T7 fences changed Start bodies", [
        mutation(CONNECTION, '(verifier !== undefined && !proofMatches(verifier, connection.verifier_hash))', '(verifier !== undefined && false)')
    ], INTEGRATION),
    control("T8-stored-notice", "T8 a stale stored account notice", [
        mutation("packages/meetings/src/recording-notice.ts", 'if (status.acknowledgement?.policyVersion !== MEETING_RECORDING_NOTICE.policyVersion)', 'if (false)')
    ], INTEGRATION),
    control("T9-revoke-persistent-proof", "T9 a proof approved over 90 days", [
        mutation(CAPABILITY, 'AND c.revoked_at IS NULL AND c.policy_version=1', 'AND c.policy_version=1')
    ], INTEGRATION),
    control("T10-account-minute", "T10 shares 10/minute admission", [
        mutation(BUDGET, 'minute.length >= 10 ?', 'false ?')
    ], INTEGRATION),
    control("T10-account-hour", "T10 enforces 60/hour independently", [
        mutation(BUDGET, 'recent.length >= 60 ?', 'false ?')
    ], INTEGRATION),
    control("T11-recording-logs", "T11 full Start/record/Stop", [
        mutation(LOGGER, 'paths: [...new Set([...paths, ...recordingSecretPaths])]', 'paths: [...paths]')
    ], INTEGRATION)
]


FAILURE_PATTERNS = {
    "R3-owned-connect-bridge": r"expected false to be true",
    "R3-owned-idle-destroy": r"expected undefined to be type of",
    "R3-owned-query-abort": r"expected false to be true",
    **{name: r"^Error: promise resolved .* instead of rejecting" for name in [
        "T1-T2-missing-device-fence", "T3-missing-capability-fence", "T4-missing-session-fence",
        "T5-post-fence-deadline", "T5-claim-deadline", "T5-capture-lease", "T5-hard-cap", "T6-auth-device-owner",
        "T7-start-fingerprint", "T7-connection-verifier", "T8-stored-notice", "T9-revoke-persistent-proof"]},
    **{name: r"expected 200 to be 401" for name in ["T1-settings-unlink-delete", "T2-native-logout-delete", "T3-capability-revoke", "T4-session-binding"]},
    "T10-minute-budget": r"expected function to throw an error, but it didn't",
    "T10-hour-budget": r"expected function to throw an error, but it didn't",
    "T10-account-minute": r"to have a length of 1 but got \+?0",
    # The independent SQL cardinality constraint still rejects row 61. This mutation
    # proves the missing semantic 429 guard, not permission to exceed the storage bound.
    "T10-account-hour": r"httpStatus",
    "T11-log-redaction": r"not to contain",
    "T11-recording-logs": r"not to contain"
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
    with output.open("w") as log:
        result = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", item["suite"],
            "-t", item["test"], "--reporter=json", f"--outputFile={path}"], cwd=ROOT,
            stdout=log, stderr=subprocess.STDOUT, timeout=600)
    if not path.exists():
        raise RuntimeError(f'{item["name"]}: no assertion report; inspect {output}')
    report = json.loads(path.read_text())
    executed = [test for test in assertions(report) if test.get("status") in ("passed", "failed")]
    matching = [test for test in executed if re.search(item["test"], test.get("fullName", ""))]
    if not matching or len(matching) != len(executed):
        raise RuntimeError(f'{item["name"]}: missing or unexpected test selection; inspect {output}')
    return result.returncode, matching, output


def run_control(item, directory):
    originals = {path: (ROOT / path).read_bytes() for path, _, _ in item["edits"]}
    try:
        for path, before, after in item["edits"]:
            file = ROOT / path
            file.write_text(file.read_text().replace(before, after, 1))
        code, tests, output = run_test(item, directory / (item["name"] + "-red.json"))
        failures = [test for test in tests if test["status"] == "failed"]
        if code == 0 or not failures:
            raise RuntimeError(f'{item["name"]}: mutation did not fail its named assertion; inspect {output}')
        for test in failures:
            failure = "\n".join(test.get("failureMessages", []))
            is_assertion = "AssertionError" in failure or (failure.startswith("Error: promise resolved ") and "__VITEST_REJECTS__" in failure)
            if (not is_assertion or not re.search(FAILURE_PATTERNS[item["name"]], failure, re.S)
                    or (item["marker"] and item["marker"] not in failure)):
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


def require_gate():
    if os.environ.get("JARVIS_GATE_RUN") != "1" or os.environ.get("MOSS_GATE_RUN") != "1":
        raise RuntimeError("Hosted controls must run through scripts/run-gate.sh --gate test:meeting-link-negative")
    targets = []
    for prefix in ("MOSS", "JARVIS"):
        for role in ("BOOTSTRAP", "MIGRATION", "APP", "AUTH", "WORKER"):
            value = os.environ.get(f"{prefix}_{role}_DATABASE_URL", "")
            url = urlparse(value)
            if not url.hostname or not re.fullmatch(r"jarvis_(?:gate|test)_[a-zA-Z0-9_]+", url.path[1:]):
                raise RuntimeError("Missing isolated gate database identity")
            targets.append((url.hostname, url.port, url.path))
    if len(set(targets)) != 1:
        raise RuntimeError("Gate roles do not target the same isolated database")


def interrupted(_signal, _frame):
    raise KeyboardInterrupt("Interrupted; restoring mutation sources")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--unit", action="store_true")
    mode.add_argument("--hosted", action="store_true")
    args = parser.parse_args()
    validate(UNIT_CONTROLS + HOSTED_CONTROLS)
    if args.check:
        print("Validated source anchors; no unit, database or negative proof was executed.")
        return
    if args.hosted:
        require_gate()
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupted)
    directory = Path(tempfile.mkdtemp(prefix="meeting-link-negative-"))
    print(f"Proof receipts: {directory}", flush=True)
    for item in HOSTED_CONTROLS if args.hosted else UNIT_CONTROLS:
        run_control(item, directory)
    print("Selected named assertions failed under mutation and passed after restoration.")
    if args.unit:
        print("Database-free unit evidence only; hosted T1–T11 integration proof remains required.")


if __name__ == "__main__":
    main()
