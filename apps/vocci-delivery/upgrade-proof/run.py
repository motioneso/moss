#!/usr/bin/env python3
"""Installed synthetic upgrade proof; operates only on its newly owned package."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = "ai.moss.vocci.upgradeproof"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--build-tools", type=Path, default=Path.home() / ".local/share/android-sdk/build-tools/35.0.0")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    result = {"scope": "synthetic installed upgrade persistence and safe network-failure restart; no physical transfer or setup claim", "checks": []}
    owned = False
    launcher = None
    xml_path = "/data/local/tmp/moss-disposable-upgrade.xml"

    def save():
        (args.out / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")

    def checkpoint(name):
        result["checkpoint"] = name
        save()

    def check(value, name):
        if not value:
            raise AssertionError(name)
        result["checks"].append(name)
        save()

    def adb(*values, timeout=45, allow_failure=False):
        result["lastOperation"] = " ".join(map(str, values[:3] if values[0] == "shell" else values[:1]))
        save()
        completed = subprocess.run(["adb", "-s", args.serial, *map(str, values)], capture_output=True, timeout=timeout)
        if completed.returncode and not allow_failure:
            raise RuntimeError("adb_operation_failed_" + "_".join(map(str, values[:3])))
        return completed.stdout

    def instrument(mode):
        output = adb("shell", "am", "instrument", "-w", "-e", "mode", mode, "-e", "port", args.port,
            PACKAGE + "/ai.moss.vocci.UpgradeFixture", timeout=60).decode()
        check("INSTRUMENTATION_CODE: -1" in output and "result=PASS" in output, "fixture_" + mode)

    def installed():
        completed = subprocess.run(["adb", "-s", args.serial, "shell", "pm", "path", PACKAGE], capture_output=True, timeout=45)
        # Android returns 1 with empty output for an absent package. Transport failures
        # carry stderr and must never be mistaken for absence or successful cleanup.
        if completed.returncode not in (0, 1) or completed.stderr.strip():
            raise RuntimeError("package_presence_check_failed")
        return bool(completed.stdout.strip())

    def state():
        return json.loads(adb("shell", "run-as", PACKAGE, "cat", "no_backup/delivery/state.json"))

    def snapshot():
        value = state()
        names = adb("shell", "run-as", PACKAGE, "find", "no_backup", "-type", "f").decode().splitlines()
        files = {}
        for name in sorted(names):
            if not re.fullmatch(r"no_backup/[A-Za-z0-9_./-]+", name):
                raise AssertionError("fixture_path_bounded")
            if name != "no_backup/delivery/state.json":
                files[name] = adb("shell", "run-as", PACKAGE, "sha256sum", name).decode().split()[0]
        stable = {"sourceIdentity": sha(value["sourceDeviceId"].encode()),
            "entries": sha(json.dumps(value["entries"], sort_keys=True).encode()),
            "voice": sha(json.dumps(value["voice"], sort_keys=True).encode()), "files": files}
        return stable

    def nodes():
        try:
            adb("shell", "uiautomator", "dump", "--compressed", xml_path, timeout=35)
            return list(ET.fromstring(adb("shell", "cat", xml_path)).iter("node"))
        finally:
            adb("shell", "rm", "-f", xml_path, allow_failure=True)

    def visible(label):
        return [node for node in nodes() if node.get("package") == PACKAGE and node.get("text") == label]

    def scroll(direction):
        current = nodes()
        edges = [list(map(int, re.findall(r"\d+", node.get("bounds", "")))) for node in current]
        edges = [edge for edge in edges if len(edge) == 4]
        height = max(edge[3] for edge in edges)
        width = max(edge[2] for edge in edges)
        top, bottom = int(height * .25), int(height * .78)
        start, end = (bottom, top) if direction == "down" else (top, bottom)
        adb("shell", "input", "swipe", width // 2, start, width // 2, end, "300")

    def click(label):
        for unused in range(9):
            found = [node for node in visible(label) if node.get("enabled") == "true"]
            if len(found) == 1:
                left, top, right, bottom = map(int, re.findall(r"\d+", found[0].get("bounds")))
                if right > left and bottom > top:
                    adb("shell", "input", "tap", (left + right) // 2, (top + bottom) // 2)
                    time.sleep(.5)
                    return
            scroll("down")
        raise AssertionError("native_control_unavailable_" + label.replace(" ", "_"))

    def launch():
        adb("shell", "am", "start", "-n", PACKAGE + "/" + launcher)
        time.sleep(1)

    def wait_activity(expected):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            value = state()
            if value.get("activity") == expected:
                return value
            time.sleep(1)
        raise AssertionError("journal_activity_unavailable_" + expected)

    try:
        checkpoint("validate_apks_and_unused_package")
        for name in ("baseline", "candidate"):
            apk = getattr(args, name).resolve()
            package = subprocess.check_output([str(args.build_tools / "aapt2"), "dump", "packagename", str(apk)], text=True).strip()
            check(package == PACKAGE, name + "_package_identity")
            metadata = json.loads((apk.parent / "build-receipt.json").read_text())
            check(metadata["apkSha256"] == sha(apk.read_bytes()), name + "_apk_digest")
            result[name] = {"apkSha256": metadata["apkSha256"], "version": metadata["version"]}
        badging = subprocess.check_output([str(args.build_tools / "aapt2"), "dump", "badging", str(args.candidate)], text=True)
        launchers = re.findall(r"^launchable-activity: name='(ai\.moss\.vocci\.[A-Za-z]+)'", badging, re.MULTILINE)
        check(len(launchers) == 1, "candidate_has_one_declared_launcher")
        launcher = launchers[0]
        manifest = ET.parse(args.candidate.parent / "AndroidManifest.xml").getroot()
        android_name, android_exported = "{http://schemas.android.com/apk/res/android}name", "{http://schemas.android.com/apk/res/android}exported"
        check(manifest.get("package") == PACKAGE and any(activity.get(android_name) == launcher and activity.get(android_exported) == "true"
            for activity in manifest.findall("application/activity")), "declared_launcher_exported_in_disposable_manifest")
        result["launcher"] = launcher
        check(args.port in range(5180, 5300), "claimed_port_range")
        check(not installed(), "package_initially_absent")
        checkpoint("install_baseline_and_generated_fixture")
        owned = True
        check("Success" in adb("install", args.baseline, timeout=90).decode(), "baseline_installed")
        instrument("init")
        before = snapshot()
        result["baselineState"] = before
        adb("shell", "am", "force-stop", PACKAGE)
        checkpoint("actual_apk_replacement")
        check("Success" in adb("install", "-r", args.candidate, timeout=90).decode(), "candidate_replaced_baseline")
        check(snapshot() == before, "all_config_and_pending_frozen_bytes_and_queue_voice_identities_preserved")
        instrument("verify")
        check(snapshot() == before, "keystore_decrypt_and_read_only_inspection_preserved_state")
        checkpoint("configured_ui_requires_unlocked_phone")
        trust = adb("shell", "dumpsys", "trust").decode()
        current = next((line for line in trust.splitlines() if "(current)" in line), "")
        check("deviceLocked=0" in current, "phone_unlocked_for_actual_ui")
        checkpoint("launch_configured_activity")
        resolved = adb("shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", PACKAGE, allow_failure=True).decode().strip()
        result["launcherResolution"] = resolved
        launch()
        checkpoint("inspect_configured_launcher_ui")
        check(not visible("Set up your ring"), "configured_launcher_skips_signin")
        click("Ring setup and delivery options")
        for unused in range(5):
            if visible("Hold-to-talk in Main chat"):
                break
            scroll("down")
        hold = visible("Hold-to-talk in Main chat")
        check(len(hold) == 1 and hold[0].get("checked") == "true" and hold[0].get("enabled") == "false", "ready_preserves_hold_while_delivery_stopped")
        check(snapshot() == before, "actual_configured_ready_does_not_change_retained_state")
        checkpoint("real_service_safe_network_failure_then_stop")
        adb("shell", "pm", "grant", PACKAGE, "android.permission.BLUETOOTH_CONNECT")
        # No reverse/listener is created. Only synthetic credentials can reach this closed loopback port.
        for unused in range(4):
            scroll("up")
        click("Start delivery")
        failure = wait_activity("retry_pending")
        check(failure.get("lastFailure") in ("ConnectException", "SSLException", "SSLHandshakeException"), "real_service_failed_before_owner_confirmation_or_ring_io")
        check(snapshot() == before, "real_service_reopen_preserves_pending_and_frozen_bytes")
        click("Stop delivery")
        wait_activity("stopped")
        check(snapshot() == before, "native_stop_preserves_source_queue_and_voice")
        adb("shell", "am", "force-stop", PACKAGE)
        launch()
        time.sleep(1)
        check(state().get("activity") == "stopped", "relaunch_does_not_restart_stopped_delivery")
        checkpoint("selection_back_installed_contract")
        # The synthetic selection contract requires an empty app. Remove only this session-owned package.
        check("Success" in adb("uninstall", PACKAGE).decode(), "owned_fixture_removed_before_empty_contract")
        check(not installed(), "owned_fixture_confirmed_absent")
        # Retain ownership across reinstall, including ambiguous installer timeouts.
        check("Success" in adb("install", args.candidate, timeout=90).decode(), "candidate_fresh_for_selection_contract")
        output = adb("shell", "am", "instrument", "-w", PACKAGE + "/ai.moss.vocci.SetupSelectionChecks", timeout=60).decode()
        check("INSTRUMENTATION_CODE: -1" in output and "result=PASS" in output, "actual_choose_another_ring_retains_moss_and_reopens_lookup")
        result["result"] = "PASS"
    except BaseException as error:
        result["result"] = "FAIL"
        result["failure"] = str(error) if isinstance(error, (AssertionError, RuntimeError)) else type(error).__name__
    finally:
        if owned:
            cleanup = {}
            for name, command in (("forceStop", ("shell", "am", "force-stop", PACKAGE)), ("uninstall", ("uninstall", PACKAGE))):
                try:
                    adb(*command, allow_failure=True)
                    cleanup[name] = "attempted"
                except Exception as error:
                    cleanup[name] = type(error).__name__
            try:
                cleaned = not installed()
            except Exception as error:
                cleanup["absenceCheck"] = type(error).__name__
                cleaned = False
            result["cleanup"] = cleanup
            result["ownedPackageRemoved"] = cleaned
            if not cleaned:
                result["result"] = "FAIL"
        save()
    print(json.dumps({key: result.get(key) for key in ("result", "checkpoint", "failure", "ownedPackageRemoved")}))
    raise SystemExit(0 if result.get("result") == "PASS" else 1)


if __name__ == "__main__":
    main()
