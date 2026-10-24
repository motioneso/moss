#!/usr/bin/env python3
"""Observe real OS package-replacement recovery using generated disposable data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = "ai.moss.vocci.upgradeproof"
SERVICE = "ai.moss.vocci.DeliveryService"
BLUETOOTH = "android.permission.BLUETOOTH_CONNECT"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--case", required=True, choices=["enabled", "disabled", "permission-denied"])
    parser.add_argument("--build-tools", type=Path, default=Path.home() / ".local/share/android-sdk/build-tools/35.0.0")
    args = parser.parse_args()
    java_home = os.environ.get("JAVA_HOME", str(Path.home() / ".local/opt/jdk-21.0.12.1+1"))
    os.environ["JAVA_HOME"] = java_home
    os.environ["PATH"] = str(Path(java_home) / "bin") + os.pathsep + os.environ.get("PATH", "")
    args.out.mkdir(parents=True, exist_ok=False)
    result = {"case": args.case, "scope": "generated-data OS replacement; no physical ring or production acceptance", "checks": []}
    owned = False

    def save():
        (args.out / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")

    def check(value, name):
        if not value:
            raise AssertionError(name)
        result["checks"].append(name)
        save()

    def adb(*values, timeout=30, absent_ok=False):
        completed = subprocess.run(["adb", "-s", args.serial, *map(str, values)], capture_output=True, timeout=timeout)
        allowed = (0, 1) if absent_ok else (0,)
        if completed.returncode not in allowed or (absent_ok and completed.stderr.strip()):
            raise RuntimeError("adb_failed_" + str(values[0]))
        return completed.stdout.decode()

    def installed():
        return bool(adb("shell", "pm", "path", PACKAGE, absent_ok=True).strip())

    def inspect(apk):
        receipt = json.loads((apk.parent / "build-receipt.json").read_text())
        check(receipt["package"] == PACKAGE, "input_receipt_disposable_identity")
        digest = hashlib.sha256(apk.read_bytes()).hexdigest()
        check(digest == receipt["apkSha256"], "input_apk_digest_matches")
        data = subprocess.run([str(args.build_tools / "aapt2"), "dump", "badging", str(apk)], capture_output=True, check=True).stdout.decode()
        check(re.search(r"package: name='" + re.escape(PACKAGE) + r"' versionCode='" + str(receipt["version"]) + "'", data), "actual_apk_identity_version")
        cert = subprocess.run([str(args.build_tools / "apksigner"), "verify", "--print-certs", str(apk)], capture_output=True, check=True).stdout.decode()
        match = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-f]+)", cert)
        check(match is not None, "apk_signature_verified")
        return receipt, match[1]

    def state():
        return json.loads(adb("shell", "run-as", PACKAGE, "cat", "no_backup/delivery/state.json"))

    def choices():
        root = ET.fromstring(adb("shell", "run-as", PACKAGE, "cat", "shared_prefs/delivery-choices.xml"))
        return {item.get("name"): item.get("value", item.text or "") for item in root}

    def snapshot():
        data = state()
        names = adb("shell", "run-as", PACKAGE, "find", "no_backup", "-type", "f").splitlines()
        check(all(re.fullmatch(r"no_backup/[A-Za-z0-9_./-]+", name) for name in names), "bounded_fixture_paths")
        files = {}
        for name in sorted(names):
            if name != "no_backup/delivery/state.json":
                files[name] = adb("shell", "run-as", PACKAGE, "sha256sum", name).split()[0]
        return {"sourceDeviceId": data["sourceDeviceId"], "entries": data["entries"], "voice": data["voice"], "files": files}

    def broadcasts():
        dump = adb("shell", "dumpsys", "activity", "broadcasts")
        blocks = re.split(r"(?m)(?=\s*BroadcastRecord\{)", dump)
        return {re.search(r"BroadcastRecord\{(\S+)", block)[1]: block[:12000]
                for block in blocks if PACKAGE in block and "android.intent.action.MY_PACKAGE_REPLACED" in block
                and re.search(r"BroadcastRecord\{(\S+)", block)}

    try:
        check(5180 <= args.port <= 5299, "claimed_port_range")
        baseline, cert = inspect(args.baseline)
        candidate, candidate_cert = inspect(args.candidate)
        check(cert == candidate_cert, "same_signing_identity")
        check(candidate["version"] > baseline["version"], "increasing_version")
        production = lambda receipt: {name: digest for name, digest in receipt["sourceFiles"].items() if name.startswith("src/")}
        check(production(baseline) and production(baseline) == production(candidate), "unchanged_production_java")
        check(baseline["fixtureSha256"] == candidate["fixtureSha256"], "same_generated_fixture")
        result["inputs"] = {"baseline": baseline["apkSha256"], "candidate": candidate["apkSha256"]}
        result["androidApi"] = adb("shell", "getprop", "ro.build.version.sdk").strip()
        check(not installed(), "refuse_existing_disposable_install")
        listeners = adb("shell", "ss", "-ltn")
        check(not re.search(r":" + str(args.port) + r"\s", listeners), "phone_loopback_port_closed")
        owned = True
        check("Success" in adb("install", str(args.baseline), timeout=90), "baseline_installed")
        if args.case != "permission-denied":
            adb("shell", "pm", "grant", PACKAGE, BLUETOOTH)
        enabled = args.case != "disabled"
        output = adb("shell", "am", "instrument", "-w", "-e", "mode", "init", "-e", "enabled", str(enabled).lower(),
                     "-e", "port", args.port, PACKAGE + "/ai.moss.vocci.UpgradeFixture", timeout=60)
        check("INSTRUMENTATION_CODE: -1" in output and "result=PASS" in output, "generated_fixture_initialized")
        before = snapshot()
        check(choices().get("enabled") == str(enabled).lower(), "baseline_choice_saved")
        check(SERVICE not in adb("shell", "dumpsys", "activity", "services", PACKAGE), "no_baseline_service")
        # No force-stop, shell broadcast, manual Start or instrumentation after replacement.
        previous_broadcasts = broadcasts()
        result["replaceStartedAt"] = time.time()
        save()
        check("Success" in adb("install", "-r", str(args.candidate), timeout=90), "candidate_replaced_baseline")
        deadline = time.monotonic() + 35
        while True:
            history = "\n".join(block for key, block in broadcasts().items() if key not in previous_broadcasts)
            service = SERVICE in adb("shell", "dumpsys", "activity", "services", PACKAGE)
            current = state()
            advice = choices().get("recovery", "")
            delivered = "ai.moss.vocci.DeliveryRecovery" in history and "DELIVERED" in history
            observed = current.get("activity") == "retry_pending" if args.case == "enabled" else bool(advice) if args.case == "permission-denied" else True
            if (delivered and observed) or time.monotonic() >= deadline:
                break
            time.sleep(2)
        (args.out / "replacement-broadcast.txt").write_text(history)
        result["observation"] = {"receiverDelivered": delivered, "servicePresent": service,
                                 "activity": current.get("activity"), "lastFailure": current.get("lastFailure"), "recoveryAdvice": advice}
        save()
        check(delivered, "os_dispatched_replacement_receiver")
        check(service == (args.case == "enabled"), "expected_service_presence")
        if args.case == "enabled":
            check(current.get("activity") == "retry_pending", "real_service_reached_closed_network_failure")
            check(current.get("lastFailure") == "ConnectException", "observed_connection_refusal")
        elif args.case == "permission-denied":
            check(advice == "Grant Nearby devices permission, then Start delivery.", "actual_permission_recovery_advice")
        else:
            check(current.get("activity") == "stopped", "disabled_delivery_stayed_stopped")
        check(choices().get("enabled") == str(enabled).lower(), "saved_choice_retained")
        check(snapshot() == before, "exact_source_queue_voice_config_evidence_retained")
        result["passed"] = True
    except Exception as error:
        result["passed"] = False
        result["failure"] = str(error) if isinstance(error, AssertionError) else type(error).__name__
    finally:
        if owned:
            try:
                check("Success" in adb("uninstall", PACKAGE, timeout=60), "owned_disposable_removed")
                check(not installed(), "owned_disposable_absent")
            except Exception as error:
                result["passed"] = False
                result["cleanupFailure"] = type(error).__name__
        save()
    print(json.dumps({key: result[key] for key in ["case", "passed", "checks", "failure", "cleanupFailure"] if key in result}))
    return 0 if result.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
