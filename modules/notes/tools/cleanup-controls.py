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


def run(source, name, test="cleanup_privacy_detects_removed_rls_and_owner_predicates"):
    args = command.copy()
    args[args.index("cleanup_privacy_detects_removed_rls_and_owner_predicates")] = test
    path = logs / (name + ".log")
    with path.open("w") as output:
        result = subprocess.run(args, cwd=source, stdout=output, stderr=subprocess.STDOUT, check=False)
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
    for name, anchor, replacement, marker in [
        ("cleanup-source-boundary", "AND left(source_path,char_length($2::text))=$2", "AND $2::text IS NOT NULL", "Legacy cleanup row mismatch"),
        ("cleanup-empty-walk", "if present.is_empty() {", "if false {", "An empty host walk must retain the index"),
    ]:
        assert original.count(anchor) == 1, f"Control anchor changed: {name}"
        path.write_text(original.replace(anchor, replacement))
        code, output = run(isolated, name, "compiled_cleanup_matches_legacy_and_rolls_back_the_whole_sweep")
        assert code != 0 and marker in output and "1 failed;" in output, output
        print(f"PASS removed {name}: compiled cleanup assertion failed", flush=True)
    path.write_text(original)
    for test in ["cleanup_privacy_detects_removed_rls_and_owner_predicates", "compiled_cleanup_matches_legacy_and_rolls_back_the_whole_sweep"]:
        code, output = run(isolated, f"restored-{test}", test)
        assert code == 0 and "1 passed;" in output, output
    print("PASS restored cleanup guards: compiled privacy, parity and rollback assertions pass", flush=True)
