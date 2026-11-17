#!/usr/bin/env python3
"""Run the real marker assertions with each protection removed, restoring source in finally.
Only the disposable gate may run this. Do not run concurrently with another build in this tree.
"""
import os
from pathlib import Path
import subprocess

assert os.environ.get("JARVIS_GATE_RUN") == "1", "Use verify-gate"
target = Path(os.environ["CARGO_TARGET_DIR"])


def run(manifest, test, case, extra, output, env=None):
    return subprocess.run(
        ["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
         manifest, "--test", test, case, "--", *extra],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env={**os.environ, "CARGO_TARGET_DIR": str(output), **(env or {})}, check=False,
    )


def control(name, path, old, new, manifest, test, case, extra, output, rebuild=False):
    source = Path(path)
    original = source.read_bytes()
    text = original.decode()
    assert text.count(old) == 1, "Protection anchor changed"
    try:
        source.write_text(text.replace(old, new))
        env = None
        if rebuild:
            # The installed test loads the packaged component, so it must carry the change.
            wasm = target / "control-module.wasm"
            subprocess.run(["modules/finance/tools/build-component.sh", str(wasm)], check=True,
                           env={**os.environ, "CARGO_TARGET_DIR": str(output)})
            env = {"FINANCE_COMPONENT_WASM": str(wasm)}
        result = run(manifest, test, case, extra, output, env)
        # Full output stays in scratch so no private marker reaches the printed receipt.
        (target / ("control-" + name.replace(" ", "-") + ".log")).write_bytes(result.stdout)
        assert result.returncode != 0 and b"test result: FAILED" in result.stdout, "Control did not fail an assertion"
        assert case.encode() in result.stdout, "Wrong test failed"
        print(f"PASS negative control: {name} assertion failed with protection removed", flush=True)
    finally:
        source.write_bytes(original)


GUEST = "a_host_failure_never_echoes_names_notes_or_amounts"
HOST = "names_notes_and_amounts_never_reach_job_payloads_activity_rows_or_logs"
BUDGET = "the_budget_is_private_drafts_use_stored_records_and_an_uncertain_save_saves_nothing"
guest_target = target / "guest"
control("error body", "modules/finance/src/lib.rs",
        '|_| Response::new(500, json!({"error":"Internal server error"}))',
        '|e| Response::new(500, json!({"error": e.to_string()}))',
        "modules/finance/src/Cargo.toml", "privacy", GUEST, [], guest_target)
# The activity row must hold ids only. Put the amount back in and the host scan must fail.
control("activity amounts", "modules/finance/src/ledger.rs",
        'json!({"accountId":account_id,"transactionId":id})',
        'json!({"accountId":account_id,"transactionId":id,"amountCents":amount})',
        "modules/finance/host/Cargo.toml", "installed", HOST, ["--ignored", "--test-threads=1"], target,
        rebuild=True)
# A budget activity row holds the month and category only. Put the amount back in and the budget scan must fail.
control("budget activity amounts", "modules/finance/src/budget_write.rs",
        'json!({"month":month,"categoryId":item.category})',
        'json!({"month":month,"categoryId":item.category,"amountCents":item.amount})',
        "modules/finance/host/Cargo.toml", "installed", BUDGET, ["--ignored", "--test-threads=1"], target,
        rebuild=True)
# Re-run both assertions after restoring their guards; a negative control alone is not proof.
# The control build reused the guest output folder, so rebuild the shipped component from restored source.
subprocess.run(["modules/finance/tools/build-component.sh", str(target / "module.wasm")], check=True,
               env={**os.environ, "CARGO_TARGET_DIR": str(target)})
for manifest, test, case, extra, output in [
    ("modules/finance/src/Cargo.toml", "privacy", GUEST, [], guest_target),
    ("modules/finance/host/Cargo.toml", "installed", HOST, ["--ignored", "--test-threads=1"], target),
    ("modules/finance/host/Cargo.toml", "installed", BUDGET, ["--ignored", "--test-threads=1"], target),
]:
    subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
                    manifest, "--test", test, case, "--", *extra],
                   env={**os.environ, "CARGO_TARGET_DIR": str(output)}, check=True)
print("PASS privacy assertions after restoring both guards", flush=True)
