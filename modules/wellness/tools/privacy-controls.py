#!/usr/bin/env python3
"""Run the real marker assertions with each protection removed, restoring source in finally.
Only the disposable gate may run this. Do not run concurrently with another build in this tree.
"""
import os
from pathlib import Path
import subprocess

assert os.environ.get("JARVIS_GATE_RUN") == "1", "Use verify-gate"
target = Path(os.environ["CARGO_TARGET_DIR"])


def control(name, path, old, new, manifest, test, case, extra):
    source = Path(path)
    original = source.read_bytes()
    text = original.decode()
    assert text.count(old) == 1, "Protection anchor changed"
    try:
        source.write_text(text.replace(old, new))
        result = subprocess.run(
            ["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
             manifest, "--test", test, case, "--", *extra],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            env={**os.environ, **({"CARGO_TARGET_DIR": str(target / "guest")} if manifest.endswith("src/Cargo.toml") else {})},
            check=False,
        )
        # No private marker or source paths in the printed receipt. Full output stays in scratch.
        (target / ("control-" + name.replace(" ", "-") + ".log")).write_bytes(result.stdout)
        assert result.returncode != 0 and b"test result: FAILED" in result.stdout, "Control did not fail an assertion"
        assert case.encode() in result.stdout, "Wrong test failed"
        print(f"PASS negative control: {name} assertion failed with protection removed", flush=True)
    finally:
        source.write_bytes(original)


GUEST = "check_in_text_reaches_no_host_call_beyond_the_check_in_table"
HOST = "check_ins_stay_private_and_a_second_person_is_refused"
control("error body", "modules/wellness/src/lib.rs",
        'result.unwrap_or_else(|_| Response::new(500, json!({"error":"Internal server error"})))',
        'result.unwrap_or_else(|e| Response::new(500, json!({"error": e.to_string()})))',
        "modules/wellness/src/Cargo.toml", "privacy", GUEST, [])
control("unchosen category", "modules/wellness/src/export.rs",
        'let therapy = if wants("therapyNotes") {',
        'let therapy = if wants("therapyNotes") || true {',
        "modules/wellness/src/Cargo.toml", "therapy_export", "a_finished_export_holds_only_the_chosen_categories", [])
control("export expiry", "modules/wellness/src/export.rs",
        'status == "ready" && instant(record, "expiresAt").is_some_and(|at| at <= now)',
        'false',
        "modules/wellness/src/Cargo.toml", "therapy_export", "an_export_reads_as_gone_after_24_hours", [])
# Re-run both assertions after restoring their guards; a negative control alone is not proof.
for manifest, test, case, extra, output in [
    ("modules/wellness/src/Cargo.toml", "therapy_export", "a_finished_export_holds_only_the_chosen_categories", [], target / "guest"),
    ("modules/wellness/src/Cargo.toml", "therapy_export", "an_export_reads_as_gone_after_24_hours", [], target / "guest"),
    ("modules/wellness/src/Cargo.toml", "privacy", GUEST, [], target / "guest"),
    ("modules/wellness/host/Cargo.toml", "installed", HOST,
     ["--ignored", "--test-threads=1"], target),
]:
    subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
                    manifest, "--test", test, case, "--", *extra],
                   env={**os.environ, "CARGO_TARGET_DIR": str(output)}, check=True)
print("PASS privacy assertions after restoring both guards", flush=True)
