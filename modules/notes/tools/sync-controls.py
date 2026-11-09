#!/usr/bin/env python3
"""Remove coordinator protections in a scratch source copy; each assertion must fail.

No database, source worktree, production adapter or installed component is changed.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[3]
CONTROLS = [
    (
        "unlink-no-op",
        'result["noOp"] = json!(true);',
        'result["noOp"] = json!(false);',
        "sync_matches_actual_legacy_coordinator",
    ),
    (
        "empty-walk-retains-index",
        "if files.is_empty() {\n        return Ok(());\n    }",
        "// Negative control: do not protect an empty walk.",
        "sync_matches_actual_legacy_coordinator",
    ),
    (
        "cleanup-stays-in-source",
        "if path.starts_with(&prefix) && !present.contains(&path)",
        "if !present.contains(&path)",
        "sync_matches_actual_legacy_coordinator",
    ),
    (
        "reported-chunks-stay-within-budget",
        "progress.filter(|p| p.chunks_processed <= budget)",
        "progress",
        "invalid_core_progress_cannot_expand_the_chunk_budget_or_disclose_errors",
    ),
    (
        "unknown-errors-do-not-echo-private-text",
        '_ => return "notes sync failed (Error)".into(),',
        '_ => return code.unwrap_or("notes sync failed (Error)").into(),',
        "invalid_core_progress_cannot_expand_the_chunk_budget_or_disclose_errors",
    ),
]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: sync-controls.py output-folder")
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="notes-sync-controls-") as folder:
        copy = Path(folder)
        for relative in ["modules/notes/src", "modules/notes/test-support", "rust-spike/module-sdk"]:
            shutil.copytree(REPO / relative, copy / relative, ignore=shutil.ignore_patterns("target"))
        source = copy / "modules/notes/src/sync.rs"
        original = source.read_text()
        env = dict(os.environ)
        env.setdefault("CARGO_TARGET_DIR", str(copy / "target"))
        command = ["cargo", "+1.95.0", "test", "--locked", "--offline", "--features", "write-tools",
                   "--manifest-path", str(copy / "modules/notes/src/Cargo.toml"), "--test", "sync"]

        def run(name, test=None):
            log = out / f"{name}.log"
            with log.open("w") as output:
                result = subprocess.run(command + ([test] if test else []), env=env,
                                        stdout=output, stderr=subprocess.STDOUT, check=False)
            return result.returncode, log.read_text()

        rc, _ = run("protected-before")
        if rc != 0:
            raise SystemExit("Protected scratch baseline failed; inspect protected-before.log")
        for name, old, replacement, test in CONTROLS:
            if original.count(old) != 1:
                raise SystemExit(f"Control anchor drifted: {name}")
            source.write_text(original.replace(old, replacement))
            rc, log = run(name, test)
            source.write_text(original)
            if rc == 0 or "test result: FAILED" not in log or "could not compile" in log:
                raise SystemExit(f"Control did not fail its assertion: {name}; inspect {name}.log")
            print(f"PASS removed {name}: assertion failed", flush=True)
        rc, _ = run("protected-restored")
        if rc != 0:
            raise SystemExit("Restored assertions failed; inspect protected-restored.log")
        print("PASS restored coordinator: all sync assertions pass; worktree source unchanged", flush=True)


if __name__ == "__main__":
    main()
