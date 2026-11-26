#!/usr/bin/env python3
"""Observe the real gate refusing missing tools and Windows runner fallback."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

from native_negative_controls import outside_dependency

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--runner-bin", type=Path)
    args = parser.parse_args()
    command = [sys.executable, str(HERE / "phase7_pg_bundle.py"),
               "--postgres", str(args.postgres), "--scratch", str(args.scratch)]

    def refuses(label, expected, env=None):
        result = subprocess.run(command, capture_output=True, text=True, env=env)
        print("COMMAND:", subprocess.list2cmdline(command))
        print(f"NEGATIVE CONTROL {label}: exit {result.returncode}")
        print(result.stderr[-2000:])
        if result.returncode == 0 or expected not in result.stderr:
            raise AssertionError(f"Gate did not refuse {label} for the expected reason")

    suffix = ".exe" if os.name == "nt" else ""
    for name in ("pg_dump", "pg_restore"):
        file = args.postgres / "bin" / (name + suffix)
        hidden = file.with_suffix(".negative-control")
        file.rename(hidden)
        try:
            refuses(f"missing {name}", f"Missing bundled tool: {name}")
        finally:
            hidden.rename(file)
    if os.name == "nt":
        if not args.runner_bin or not (args.runner_bin / "postgres.exe").is_file():
            raise ValueError("Windows negative control needs the real runner PostgreSQL bin folder")
        env = dict(os.environ)
        env["PATH"] = str(args.runner_bin) + os.pathsep + env["PATH"]
        refuses("runner PostgreSQL on PATH", "Windows PATH selects a runner copy", env)
    outside_dependency(args.postgres.resolve(), args.scratch.resolve(), refuses)


if __name__ == "__main__":
    main()
