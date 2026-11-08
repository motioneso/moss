#!/usr/bin/env python3
"""Observe the compiled Notes privacy assertion fail in an isolated source copy.

No database or installed application is used. The worktree's host guard is never
modified; even a killed control cannot leave that source unprotected.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[3]
logs = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/notes-tool-controls").resolve()
logs.mkdir(parents=True, exist_ok=True)
assert os.environ.get("NOTES_TOOL_COMPONENT"), "Build Notes and set NOTES_TOOL_COMPONENT"
command = [
    "cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
    "modules/notes/tools/Cargo.toml", "--test", "write_tools",
    "compiled_guest_cannot_read_or_mutate_another_owners_folder", "--", "--nocapture",
]
env = dict(os.environ)
env.setdefault("CARGO_BUILD_JOBS", "2")


def run(source, name):
    with (logs / (name + ".log")).open("w") as out:
        result = subprocess.run(command, cwd=source, env=env, stdout=out,
                                stderr=subprocess.STDOUT, check=False)
    return result.returncode, (logs / (name + ".log")).read_text()


with tempfile.TemporaryDirectory(prefix="notes-privacy-source-") as folder:
    isolated = Path(folder)
    for relative in ["rust-spike", "modules/notes", "packages/notes"]:
        shutil.copytree(root / relative, isolated / relative,
                        ignore=shutil.ignore_patterns("target", "node_modules", ".git"))
    code, output = run(isolated, "protected-before")
    assert code == 0 and "1 passed;" in output, output
    path = isolated / "rust-spike/module-host/src/linked_notes.rs"
    original = path.read_text()
    guard = "folder.actor == scope.access().actor_user_id()"
    assert original.count(guard) == 2, "Account guard changed; inspect before mutating"
    path.write_text(original.replace(guard, "true"))
    code, output = run(isolated, "account-guard-removed")
    assert code != 0 and "1 failed;" in output and "test result: FAILED" in output, output
    print("PASS negative control: compiled guest privacy assertion failed without the account guard", flush=True)
    path.write_text(original)
    code, output = run(isolated, "protected-after")
    assert code == 0 and "1 passed;" in output, output
    print("PASS restored guard: compiled guest cross-account read/change refusal", flush=True)
