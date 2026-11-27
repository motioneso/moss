#!/usr/bin/env python3
"""Each deliberately removed Restore protection must make the real runner fail."""
import subprocess
import sys
from pathlib import Path
from phase7_restore_new_machine import build

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "src/restore.rs"
CONTROLS = {
    "skip-chunk-check": (
        "    check_chunks(&mut input, &header, &master)?;",
        "    // negative control: skip preflight",
        "damaged archive is checked before any staging write",
    ),
    "keep-partial-stage": (
        "        fs::remove_dir_all(&stage).map_err(|_| Failure::Restore)?;",
        "        // negative control: keep the failed stage",
        "failed restore removes its partial staging root",
    ),
    "plaintext-master": (
        '        event("data-checked");',
        '        event("data-checked");\n        fs::write(stage.join("leaked-master"), master.bytes()).unwrap();',
        "restored root contains no plaintext master or restored credential value",
    ),
}


def main():
    argv = sys.argv[1:]
    only = None
    if argv[:1] == ["--only"]:
        only, argv = argv[1], argv[2:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    original = SOURCE.read_text()
    failed = []
    try:
        for name, (before, after, assertion) in CONTROLS.items():
            if only and name != only:
                continue
            if original.count(before) != 1:
                raise AssertionError(f"control patch no longer matches: {name}")
            SOURCE.write_text(original.replace(before, after))
            try:
                build()
                done = subprocess.run([sys.executable, str(HERE / "phase7_restore_new_machine.py"), "--no-build", *argv],
                                      text=True, capture_output=True, timeout=2400)
            finally:
                SOURCE.write_text(original)
            output = done.stdout + done.stderr
            print(f"control {name}: exact runner exit {done.returncode}", flush=True)
            print("\n".join(output.splitlines()[-28:]), flush=True)
            if done.returncode != 1 or assertion not in output:
                failed.append(name)
            else:
                print(f"ok: {name} failed on its own assertion", flush=True)
    finally:
        SOURCE.write_text(original)
        build()
    if failed:
        raise AssertionError(f"negative controls did not prove their assertion: {failed}")
    print("restore negative controls PASS", flush=True)


if __name__ == "__main__":
    main()
