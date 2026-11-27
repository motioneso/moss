#!/usr/bin/env python3
"""Negative controls for phase7_backup_engine.

Each control removes one protection from the source, rebuilds, and runs the runner, which must
fail on the assertion that guards that protection. The source is restored and rebuilt after
every control, so the tree ends as it started.

usage: backup_negative_controls.py [--only NAME] -- <runner arguments without --no-build>
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
RUNNER = HERE / "phase7_backup_engine.py"

CONTROLS = {
    # Verify checks the hash and stops, without restoring anything.
    "hash-only": {
        "patches": [(
            "drill.rs",
            '        return Err("the archive is not the file the ledger recorded".into());\n    }\n',
            '        return Err("the archive is not the file the ledger recorded".into());\n    }\n'
            "    return Ok(Report { tables: 0, rows: 0, files: 0, dump_bytes: 0 });\n",
        )],
        "expect": "a flipped byte fails verify even when its hash matches the ledger",
    },
    # The archive carries the wrapped credentials in plaintext after its last chunk.
    "plaintext": {
        "patches": [(
            "capture.rs",
            "        let mut out = finish(writer, &id, created_at, manifest)?;\n",
            "        let mut out = finish(writer, &id, created_at, manifest)?;\n"
            "        out.write_all(&custody::unwrap_with_master(&key_bundle, &master).unwrap()).unwrap();\n",
        )],
        "expect": "a byte search of the archive finds no plaintext secret",
    },
    # Capture takes neither the write fence nor the table locks.
    "no-fence": {
        "patches": [
            ("capture.rs",
             '    let _fence = fence::exclusive(instance).map_err(|e| format!("write fence: {e}"))?;\n', ""),
            ("capture.rs", "    if !tables.is_empty() {\n", "    if false {\n"),
        ],
        "expect": "a backup captured while a writer held the fence",
    },
    # Roles are copied with their password verifiers and may sign in, as a naive restore would.
    "worker-login": {
        "patches": [
            ("capture.rs",
             '"SELECT rolname, rolinherit, rolcreaterole, rolcreatedb FROM pg_roles \\',
             '"SELECT rolname, rolinherit, rolcreaterole, rolcreatedb, rolpassword FROM pg_authid \\'),
            ("capture.rs",
             '                "createDb": r.get::<_, bool>(3),\n',
             '                "createDb": r.get::<_, bool>(3),\n'
             '                "password": r.get::<_, Option<String>>(4),\n'),
            ("drill.rs",
             '"CREATE ROLE {} NOLOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION {} {} {}",\n'
             "            quote_ident(name),\n",
             '"CREATE ROLE {} LOGIN PASSWORD \'{}\' NOSUPERUSER NOBYPASSRLS NOREPLICATION {} {} {}",\n'
             '            quote_ident(name),\n            role["password"].as_str().unwrap_or(""),\n'),
        ],
        "expect": "a worker holding every real credential cannot sign in to the drill",
    },
}


def build():
    subprocess.run([sys.executable, "-c", f"import runpy, sys; sys.argv=['x']; "
                    f"m = runpy.run_path({str(RUNNER)!r}, run_name='lib'); m['build']()"], check=True)


def apply(patches):
    originals = {}
    for name, old, new in patches:
        path = SRC / name
        originals.setdefault(path, path.read_text())
        text = path.read_text()
        if text.count(old) != 1:
            restore(originals)
            raise SystemExit(f"control patch no longer matches {name}: {old!r}")
        path.write_text(text.replace(old, new))
    return originals


def restore(originals):
    for path, text in originals.items():
        path.write_text(text)


def main():
    argv = sys.argv[1:]
    only = None
    if argv[:1] == ["--only"]:
        only, argv = argv[1], argv[2:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    failures = []
    for name, control in CONTROLS.items():
        if only and name != only:
            continue
        originals = apply(control["patches"])
        try:
            build()
            done = subprocess.run([sys.executable, str(RUNNER), "--no-build", *argv], capture_output=True, text=True)
        finally:
            restore(originals)
        tail = "\n".join(done.stdout.splitlines()[-6:])
        wanted = f"phase7_backup_engine FAIL: {control['expect']}"
        print(f"--- control {name}: runner exit {done.returncode}\n{tail}", flush=True)
        if done.returncode != 1 or wanted not in done.stdout:
            failures.append(name)
            print(f"control {name} did NOT fail on: {control['expect']}", flush=True)
            print(done.stderr[-4000:], flush=True)
        else:
            print(f"control {name} failed as required", flush=True)
    build()
    if failures:
        print(f"negative controls that did not fail: {failures}")
        sys.exit(1)
    print("backup negative controls PASS")


if __name__ == "__main__":
    main()
