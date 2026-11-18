#!/usr/bin/env python3
"""Observe privacy/CAS tests fail without their guards, then pass after restoration.

Run alone in this worktree, after the ordinary host tests have finished. Never runs
against a database or an installed app. Temporary source mutations are restored
even when a test or build fails. Evidence stays outside the checkout.
"""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
logs = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/js47-controls")
logs.mkdir(parents=True, exist_ok=True)
command = [
    "cargo", "+1.95.0", "test", "--locked", "--manifest-path",
    "rust-spike/module-host/Cargo.toml", "--test", "linked_notes",
]
env = dict(os.environ)
env.setdefault("CARGO_TARGET_DIR", "/tmp/js47-host-target")
env.setdefault("CARGO_BUILD_JOBS", "2")


def run(name, test_filter=None):
    args = command + ([test_filter] if test_filter else [])
    with (logs / (name + ".log")).open("w") as output:
        result = subprocess.run(args, cwd=root, env=env, stdout=output,
                                stderr=subprocess.STDOUT, check=False)
    return result.returncode, (logs / (name + ".log")).read_text()


controls = [
    ("destination", "rust-spike/module-host/src/linked_notes.rs",
     "expected_destination == Some(destination_id.as_str())", "true",
     "relinked_folder_refuses_an_old_destination_even_with_identical_text", 1),
    ("privacy", "rust-spike/module-host/src/linked_notes.rs",
     "folder.actor == scope.access().actor_user_id()", "true",
     "a_folder_resolved_for_another_account_cannot_be_", 2),
    ("expected-content", "rust-spike/vault/src/linked_files.rs",
     "self.current_text(path, limit)?.as_deref() != expected", "false",
     "stale_content_refuses_write_and_delete", 1),
]
for name, file, old, new, test_filter, failures in controls:
    path = root / file
    original = path.read_text()
    assert original.count(old) == 1, "guard changed; inspect before running controls"
    try:
        path.write_text(original.replace(old, new))
        code, output = run(name + "-removed", test_filter)
        assert code != 0 and f"{failures} failed;" in output and "test result: FAILED" in output, output
        print(f"{name}: observed {failures} failing test(s) with protection removed", flush=True)
    finally:
        path.write_text(original)

code, output = run("protected")
assert code == 0, output
print("Restored protections: complete linked-notes guest suite passes", flush=True)
print(f"Real command output: {logs}", flush=True)
