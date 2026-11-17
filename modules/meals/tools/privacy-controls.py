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
            env={**os.environ, **({"CARGO_TARGET_DIR": str(target / "guest")} if name == "tool error" else {})},
            check=False,
        )
        # No private marker or source paths in the printed receipt. Full output stays in scratch.
        (target / ("control-" + name.replace(" ", "-") + ".log")).write_bytes(result.stdout)
        assert result.returncode != 0 and b"test result: FAILED" in result.stdout, "Control did not fail an assertion"
        assert case.encode() in result.stdout, "Wrong test failed"
        print(f"PASS negative control: {name} assertion failed with protection removed", flush=True)
    finally:
        source.write_bytes(original)


control("tool error", "modules/meals/src/lib.rs",
        '.map_err(|_| moss_module_sdk::Error::new("Meals tool failed"))?',
        '.map_err(|error| error)?', "modules/meals/src/Cargo.toml", "privacy",
        "private_text_reaches_no_host_call_beyond_the_meals_tables", [])
control("host activity", "rust-spike/module-host/src/services.rs",
        '"success":result.is_ok(),"at":chrono::Utc::now()',
        '"success":result.is_ok(),"parameters":r.parameters,"at":chrono::Utc::now()',
        "modules/meals/host/Cargo.toml", "installed",
        "tools_keep_both_tables_private_and_leave_no_text_behind",
        ["--ignored", "--test-threads=1"])
control("host activity lists", "rust-spike/module-host/src/services.rs",
        '"success":result.is_ok(),"at":chrono::Utc::now()',
        '"success":result.is_ok(),"parameters":r.parameters,"at":chrono::Utc::now()',
        "modules/meals/host/Cargo.toml", "installed",
        "lists_and_pantry_are_private_and_clearing_a_list_touches_nothing_else",
        ["--ignored", "--test-threads=1"])
control("host activity cooking", "rust-spike/module-host/src/services.rs",
        '"success":result.is_ok(),"at":chrono::Utc::now()',
        '"success":result.is_ok(),"parameters":r.parameters,"at":chrono::Utc::now()',
        "modules/meals/host/Cargo.toml", "installed",
        "ratings_and_undo_records_are_private_and_keep_text_out_of_jobs_and_activity",
        ["--ignored", "--test-threads=1"])

# Re-run both assertions after restoring their guards; a negative control alone is not proof.
for manifest, test, case, extra, output in [
    ("modules/meals/src/Cargo.toml", "privacy",
     "private_text_reaches_no_host_call_beyond_the_meals_tables", [], target / "guest"),
    ("modules/meals/host/Cargo.toml", "installed",
     "tools_keep_both_tables_private_and_leave_no_text_behind",
     ["--ignored", "--test-threads=1"], target),
    ("modules/meals/host/Cargo.toml", "installed",
     "lists_and_pantry_are_private_and_clearing_a_list_touches_nothing_else",
     ["--ignored", "--test-threads=1"], target),
    ("modules/meals/host/Cargo.toml", "installed",
     "ratings_and_undo_records_are_private_and_keep_text_out_of_jobs_and_activity",
     ["--ignored", "--test-threads=1"], target),
]:
    subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
                    manifest, "--test", test, case, "--", *extra],
                   env={**os.environ, "CARGO_TARGET_DIR": str(output)}, check=True)
print("PASS privacy assertions after restoring both guards", flush=True)
