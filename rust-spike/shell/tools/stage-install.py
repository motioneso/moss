#!/usr/bin/env python3
"""Stage an unsigned, relocatable Moss install from built programs and a Phase 1 PG bundle.

Usage: stage-install.py --dist DIST --postgres PG --out NEW_DIRECTORY
No system changes, downloads, signing, or database creation. The app provisions on first use.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from linux_runtime import stage_runtime


def stage(dist: Path, postgres: Path, out: Path, server_runtime: bool = False,
          openssl: Path = Path("/usr/bin/openssl"),
          ca_bundle: Path = Path("/etc/ssl/certs/ca-certificates.crt")) -> None:
    repo = Path(__file__).resolve().parents[3]
    if out.exists():
        raise ValueError("Output already exists; choose a new folder")
    # These paths are owned by the Phase 1 migration runner. Do not maintain a second list.
    source = (repo / "rust-spike/bundled-db/src/migrate.rs").read_text()
    folders = re.search(r"pub const FOLDERS:.*?= \[(.*?)\];", source, re.S)
    bootstrap = re.search(r'const BOOTSTRAP: &str = "([^"]+)";', source)
    if not folders or not bootstrap:
        raise ValueError("Cannot read the database supervisor's schema layout")
    schema = re.findall(r'"([^"]+)"', folders[1]) + [bootstrap[1]]
    for name in ("moss-app", "moss-shell", "moss-db"):
        if not (dist / name).is_file() or not os.access(dist / name, os.X_OK):
            raise ValueError(f"Missing executable: {name}")
    for name in ("bin/postgres", "bin/initdb", "bin/pg_ctl", "share/postgresql/extension/vector.control", "lib/postgresql/vector.so", "lib/postgresql/moss_nodump.so"):
        if not (postgres / name).is_file():
            raise ValueError(f"Incomplete Phase 1 PostgreSQL bundle: {name}")
    if not (dist / "web/index.html").is_file():
        raise ValueError("Missing built web assets")
    for folder in schema:
        if not (repo / folder).is_dir():
            raise ValueError(f"Missing schema folder: {folder}")
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".moss-stage-", dir=out.parent))
    try:
        for name in ("moss-app", "moss-shell", "moss-db"):
            shutil.copy2(dist / name, temporary / name)
        shutil.copytree(dist / "web", temporary / "web")
        shutil.copytree(postgres, temporary / "postgres", symlinks=True)
        for file in (temporary / "postgres").rglob("*"):
            if file.is_symlink() and not file.resolve().is_relative_to(temporary.resolve()):
                raise ValueError("PostgreSQL bundle has a link outside its install folder")
        for folder in schema:
            target = temporary / "schema" / folder
            target.mkdir(parents=True)
            for file in sorted((repo / folder).iterdir()):
                if file.is_file() and file.name.endswith((".sql", ".mjs")):
                    shutil.copy2(file, target / file.name)
        shutil.copy2(Path(__file__).with_name("uninstall.py"), temporary / "uninstall.py")
        if server_runtime:
            stage_runtime(temporary, openssl, ca_bundle)
        # No source folders, instance data, credentials or toolchain caches are copied.
        entries = {}
        for file in sorted(temporary.rglob("*")):
            if file.is_symlink():
                resolved = file.resolve()
                if not resolved.is_relative_to(temporary.resolve()):
                    raise ValueError("PostgreSQL bundle has a link outside its install folder")
            if file.is_file():
                entries[str(file.relative_to(temporary))] = hashlib.sha256(file.read_bytes()).hexdigest()
        (temporary / "install-manifest.json").write_text(json.dumps({"format": 1, "signed": False, "files": entries}, indent=2) + "\n")
        temporary.rename(out)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("dist", "postgres", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--linux-server-runtime", action="store_true",
                        help="Include the build platform's headless ELF/OpenSSL/CA closure (not WebKit)")
    parser.add_argument("--openssl", type=Path, default=Path("/usr/bin/openssl"))
    parser.add_argument("--ca-bundle", type=Path, default=Path("/etc/ssl/certs/ca-certificates.crt"))
    args = parser.parse_args()
    stage(args.dist.resolve(), args.postgres.resolve(), args.out.resolve(),
          args.linux_server_runtime, args.openssl.resolve(), args.ca_bundle.resolve())
    print("Staged unsigned Moss app, server, database supervisor, PostgreSQL and schema")


if __name__ == "__main__":
    main()
