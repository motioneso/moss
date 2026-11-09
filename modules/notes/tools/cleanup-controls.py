#!/usr/bin/env python3
"""Compiled cleanup must fail privacy assertions if both owner filters and RLS
are removed, then pass restored. Worktree protections are never edited."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

assert os.environ.get("JARVIS_GATE_RUN") == "1", "Use scripts/run-gate.sh"
root = Path(__file__).resolve().parents[3]
logs = Path(sys.argv[1]).resolve()
logs.mkdir(parents=True, exist_ok=True)
command = ["cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
           "modules/notes/tools/Cargo.toml", "--test", "cleanup", "cleanup_privacy_detects_removed_rls_and_owner_predicates",
           "--", "--ignored", "--nocapture", "--test-threads=1"]


def run(source, name):
    path = logs / (name + ".log")
    with path.open("w") as output:
        result = subprocess.run(command, cwd=source, stdout=output, stderr=subprocess.STDOUT, check=False)
    return result.returncode, path.read_text()


with tempfile.TemporaryDirectory(prefix="notes-cleanup-source-") as folder:
    isolated = Path(folder)
    for relative in ["rust-spike", "modules/notes", "modules/people", "packages/notes"]:
        shutil.copytree(root / relative, isolated / relative, ignore=shutil.ignore_patterns("target", "node_modules", ".git"))
    shutil.copyfile(root / "LICENSE", isolated / "LICENSE")
    path = isolated / "rust-spike/module-host/src/memory_cleanup.rs"
    original = path.read_text()
    predicate = "owner_user_id=app.current_actor_user_id()"
    assert original.count(predicate) == 5, "Owner predicates changed; inspect before mutating"
    path.write_text(original.replace(predicate, "true"))
    code, output = run(isolated, "owner-predicates-removed")
    assert code != 0 and "cleanup owner predicate failed under removed RLS" in output and "1 failed;" in output, output
    print("PASS removed cleanup owner predicates + RLS: compiled privacy assertion failed", flush=True)
    path.write_text(original)
    code, output = run(isolated, "owner-predicates-restored")
    assert code == 0 and "1 passed;" in output, output
    print("PASS restored cleanup owner predicates: compiled privacy assertions pass", flush=True)
