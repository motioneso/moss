#!/usr/bin/env python3
"""Remove only the search owner predicate in a temporary source tree. The real
installed-component check must fail with RLS also removed, then pass restored.
Runs only inside verify-gate; the test restores RLS before propagating a failure.
"""
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
command = [
    "cargo", "+1.95.0", "test", "--locked", "--offline", "--manifest-path",
    "modules/notes/tools/Cargo.toml", "--test", "search", "--",
    "--ignored", "--nocapture", "--test-threads=1",
]


def run(source, name):
    path = logs / (name + ".log")
    with path.open("w") as output:
        result = subprocess.run(command, cwd=source, stdout=output,
                                stderr=subprocess.STDOUT, check=False)
    return result.returncode, path.read_text()


with tempfile.TemporaryDirectory(prefix="notes-search-source-") as folder:
    isolated = Path(folder)
    # Cargo resolves the host's People dev-dependency even for this Notes target.
    for relative in ["rust-spike", "modules/notes", "modules/people", "packages/notes"]:
        shutil.copytree(root / relative, isolated / relative,
                        ignore=shutil.ignore_patterns("target", "node_modules", ".git"))
    shutil.copyfile(root / "LICENSE", isolated / "LICENSE")
    path = isolated / "rust-spike/module-host/src/memory_search.rs"
    original = path.read_text()
    predicate = "AND owner_user_id = app.current_actor_user_id() "
    assert original.count(predicate) == 1, "Owner predicate changed; inspect before mutating"
    path.write_text(original.replace(predicate, ""))
    code, output = run(isolated, "owner-predicate-removed")
    assert code != 0 and "search owner predicate failed under removed RLS" in output and "1 failed;" in output, output
    print("PASS search owner-predicate removal: installed compiled guest privacy assertion failed with predicate and RLS removed", flush=True)
    path.write_text(original)
    code, output = run(isolated, "owner-predicate-restored")
    assert code == 0 and "1 passed;" in output, output
    print("PASS restored search owner predicate: installed compiled search and RLS controls", flush=True)
