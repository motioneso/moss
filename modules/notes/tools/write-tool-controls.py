#!/usr/bin/env python3
"""Observe the compiled Notes guest privacy assertion fail without the host account guard.

Run only after ordinary host builds/gates finish. The mutated source is restored
in finally. This uses scratch folders and no database or installed application.
"""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
logs = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/notes-tool-controls")
logs.mkdir(parents=True, exist_ok=True)
assert os.environ.get("NOTES_TOOL_COMPONENT"), "Build Notes and set NOTES_TOOL_COMPONENT"
command = [
    "cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
    "modules/notes/tools/Cargo.toml", "--test", "write_tools",
    "compiled_guest_cannot_read_or_mutate_another_owners_folder", "--", "--nocapture",
]
env = dict(os.environ)
env.setdefault("CARGO_BUILD_JOBS", "2")


def run(name):
    with (logs / (name + ".log")).open("w") as out:
        result = subprocess.run(command, cwd=root, env=env, stdout=out,
                                stderr=subprocess.STDOUT, check=False)
    return result.returncode, (logs / (name + ".log")).read_text()


code, output = run("protected-before")
assert code == 0 and "1 passed;" in output, output
path = root / "rust-spike/module-host/src/linked_notes.rs"
original = path.read_text()
guard = "folder.actor == scope.access().actor_user_id()"
assert original.count(guard) == 2, "Account guard changed; inspect before mutating"
try:
    path.write_text(original.replace(guard, "true"))
    code, output = run("account-guard-removed")
    assert code != 0 and "1 failed;" in output and "test result: FAILED" in output, output
    print("PASS negative control: compiled guest privacy assertion failed without the account guard", flush=True)
finally:
    path.write_text(original)
code, output = run("protected-after")
assert code == 0 and "1 passed;" in output, output
print("PASS restored guard: compiled guest cross-account read/change refusal", flush=True)
