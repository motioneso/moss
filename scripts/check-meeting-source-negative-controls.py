#!/usr/bin/env python3
"""Database-free named guard-removal proofs for native source-change admission.

Run only in an isolated checkout with no concurrent TypeScript reads or writes.
The shared proof runner requires a named assertion failure, rejects setup/import
failures, restores each edited source byte-for-byte, then requires a green rerun.
"""
import argparse
import importlib.util
from pathlib import Path
import signal
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("meeting_link_negative", ROOT / "scripts/check-meeting-link-negative-controls.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
DOMAIN = "packages/meetings/src/capture-domain.ts"
SERVICE = "packages/meetings/src/capture-service.ts"
BINDING = "packages/meetings/src/capture-binding.ts"
CHANGES = "tests/unit/meeting-capture-source-changes.test.ts"
SECURITY = "tests/unit/meeting-capture-source-security.test.ts"
ORDER = "tests/unit/meeting-capture-source-order.test.ts"
RECOVERY_LIMITS = "tests/unit/meeting-capture-recovery-limits.test.ts"
mutation, control = runner.mutation, runner.control
CONTROLS = [
    control("S1-source-epoch", "rejects stale source intent", [mutation(
        DOMAIN,
        "if (input.expectedGeneration !== state.generation || input.expectedEpoch !== current?.epoch)",
        "if (input.expectedGeneration !== state.generation)")], CHANGES),
    control("S2-paused-intent", "keeps a paused source edit paused", [mutation(
        DOMAIN,
        "  state.epochs.push(next);\n  state.generation += 1;",
        '  state.epochs.push(next);\n  state.desired = "recording";\n  state.generation += 1;')], CHANGES),
    control("S3-native-binding-fence", "holds the recording binding fence for source changes", [mutation(
        SERVICE,
        "      const fingerprint = hash(captureMetadataJson(input));\n      return this.nativeTransaction(proof, async (db, grant) => {",
        "      const fingerprint = hash(captureMetadataJson(input));\n      return this.deps.dataContext.withDataContext(proof.actor, async (db) => {\n        const grant = proof.grant;")], SECURITY),
    control("S4-post-fence-expiry", "rechecks the immutable grant deadline after acquiring", [mutation(
        BINDING,
        "if (protect && grant.expires_at <= (deps.now ?? (() => new Date()))())",
        "if (false)")], SECURITY),
    control("S5-full-intent-fingerprint", "binds source-change receipts to the entire body", [mutation(
        SERVICE,
        "const fingerprint = hash(captureMetadataJson(input));",
        "const fingerprint = hash(captureMetadataJson({ command: input.command, expectedGeneration: input.expectedGeneration }));")], CHANGES),
    control("S6-explicit-source", "rejects both-off and missing microphone fields", [mutation(
        DOMAIN,
        '} else if (selection.mode !== "computer-audio" || selection.microphone !== null) invalid();',
        "}")], CHANGES),
    control("S7-exact-exclusions", 'rejects unverified source selection.*"other"', [mutation(
        DOMAIN,
        "  validateCaptureSelection(input.selection, state.inventory);\n  // A source ID",
        "  // A source ID")], CHANGES),
    control("S8-older-source-registration", "persists a first old source after the newer provider result", [mutation(
        "packages/meetings/src/capture-transcript-sources.ts",
        "    if (epoch.epoch > input.epoch) break;",
        "    if (epoch.epoch !== input.epoch) continue;")], ORDER),
    control("S9-stop-finalization", "lets Stop supersede stale source intent", [mutation(
        SERVICE,
        'if (grant.status !== "active" || !grant.credential_hash)\n          throw new MeetingCaptureError("meeting_capture_conflict", 409);',
        'if (grant.status !== "active" || !grant.credential_hash) throw new MeetingCaptureError();')], CHANGES, "source-stop-finalization-conflict"),
    control("S10-automatic-recovery-budget", "caps repeated completed episodes", [mutation(
        DOMAIN,
        "recoveryCount >= MAX_AUTOMATIC_RECOVERIES ||",
        "false ||")], RECOVERY_LIMITS),
    control("S11-manual-epoch-reserve", "reserves the last eight epochs for manual controls", [mutation(
        DOMAIN,
        "state.epochs.length >= MAX_CAPTURE_EPOCHS - MANUAL_CAPTURE_EPOCH_RESERVE",
        "false")], RECOVERY_LIMITS),
    control("S12-recovery-count-shape", "rejects a malformed persisted recovery count.*-1", [mutation(
        DOMAIN,
        "    if (!Number.isSafeInteger(recoveryCount) || recoveryCount < 0) invalid();\n",
        "")], RECOVERY_LIMITS)
]
runner.FAILURE_PATTERNS.update({
    item["name"]: r"^Error: promise resolved .* instead of rejecting"
    for item in CONTROLS if item["name"] not in {"S2-paused-intent", "S8-older-source-registration", "S9-stop-finalization", "S11-manual-epoch-reserve", "S12-recovery-count-shape"}
})
runner.FAILURE_PATTERNS.update({"S2-paused-intent": r"expected", "S8-older-source-registration": r"expected", "S9-stop-finalization": r"source-stop-finalization-conflict.*meeting_capture_unavailable.*meeting_capture_conflict"})
runner.FAILURE_PATTERNS.update({"S11-manual-epoch-reserve": r"expected.*throw", "S12-recovery-count-shape": r"expected.*throw"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--unit", action="store_true")
    args = parser.parse_args()
    runner.validate(CONTROLS)
    if args.check:
        print("Source-change guard anchors validated; no proof executed.")
        return
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, runner.interrupted)
    directory = Path(tempfile.mkdtemp(prefix="meeting-source-negative-"))
    print(f"Proof receipts: {directory}", flush=True)
    for item in CONTROLS:
        runner.run_control(item, directory)
    print("Twelve source-change named assertions RED under guard removal; restored GREEN.")
    print("Database-free behavioral proof only; hosted integration and installed Mac proof remain required.")


if __name__ == "__main__":
    main()
