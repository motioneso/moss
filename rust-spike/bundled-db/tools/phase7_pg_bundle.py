#!/usr/bin/env python3
"""Isolated real-server proof of the pinned bundle, with no shared/dev database access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import tempfile

from bundle_libraries import validate_mac, validate_windows

HERE = Path(__file__).resolve().parent
SOURCES = json.loads((HERE / "sources.json").read_text())
TOOLS = ("postgres", "initdb", "pg_ctl", "psql", "pg_dump", "pg_restore", "pg_config")


def validate(bundle):
    suffix = ".exe" if os.name == "nt" else ""
    tools = {name: bundle / "bin" / (name + suffix) for name in TOOLS}
    for name, file in tools.items():
        if not file.is_file() or not os.access(file, os.X_OK):
            raise ValueError(f"Missing bundled tool: {name}")
        if not file.resolve().is_relative_to(bundle):
            raise ValueError(f"Tool escapes bundle: {name}")
    manifest = json.loads((bundle / "bundle.json").read_text())
    if manifest.get("format") != 1 or manifest.get("sources") != SOURCES:
        raise ValueError("Not the pinned source bundle")
    for name, file in tools.items():
        with file.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if manifest["tools"].get(name) != actual:
            raise ValueError(f"Bundle tool hash mismatch: {name}")
        # On Windows the job must select this bundle even for a bare tool name.
        if os.name == "nt":
            selected = shutil.which(name)
            if not selected or Path(selected).resolve() != file.resolve():
                raise ValueError(f"Windows PATH selects a runner copy of {name}: {selected}")
    return tools


def validate_libraries(bundle, tools, env):
    if platform.system() == "Darwin":
        validate_mac(bundle)
        return
    if platform.system() == "Windows":
        validate_windows(bundle)
        return
    # ldd on an executable follows its full inherited RPATH closure. Running
    # it on a copied ICU library alone discards that loader context and reports
    # a false system dependency even when the executable is self-contained.
    for file in tools.values():
        result = subprocess.run(["ldd", str(file)], env=env, capture_output=True, text=True, check=True)
        for line in result.stdout.splitlines():
            if "=>" not in line:
                continue
            library, location = line.split("=>", 1)
            library = library.strip()
            location = location.rsplit(" (", 1)[0].strip()
            if not location.startswith("/"):
                raise ValueError(f"Missing runtime library for {file.name}: {library}")
            if library.startswith(("libc.so", "libm.so", "libpthread.so", "libdl.so", "librt.so")):
                continue
            if not Path(location).resolve().is_relative_to(bundle):
                raise ValueError(f"Runtime library outside bundle for {file.name}: {library}")


def proof(bundle, scratch):
    tools = validate(bundle)
    # Discard inherited libpq settings, so a developer's PGHOST/PGSERVICE cannot
    # redirect even a maintenance command to another database.
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith("PG") and k not in ("LD_LIBRARY_PATH", "LD_PRELOAD")}
    validate_libraries(bundle, tools, env)
    env.update(PGHOST="127.0.0.1", PGUSER="bundle_proof", PGDATABASE="postgres",
               PGCONNECT_TIMEOUT="10")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        env["PGPORT"] = str(sock.getsockname()[1])
    def run(name, *args):
        command = [str(tools[name]), *map(str, args)]
        print("+", subprocess.list2cmdline(command), flush=True)
        # A Windows background postgres can inherit pg_ctl's capture pipes.
        # File-backed output lets pg_ctl return without waiting for server EOF.
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8", errors="replace") as output:
            result = subprocess.run(command, env=env, stdout=output,
                                    stderr=subprocess.STDOUT, timeout=120)
            output.seek(0)
            captured = output.read()
        if result.returncode:
            raise RuntimeError(f"{name} exit {result.returncode}: {captured}")
        return captured.strip()

    with tempfile.TemporaryDirectory(prefix="phase7-pg-", dir=scratch) as root:
        root = Path(root)
        data, log = root / "data", root / "server.log"
        run("initdb", "-D", data, "-U", "bundle_proof", "--auth=trust", "--encoding=UTF8",
            "--locale-provider=icu", "--icu-locale=und", "--lc-collate=C")
        with (data / "postgresql.conf").open("a") as file:
            file.write(f"\nlisten_addresses='127.0.0.1'\nport={env['PGPORT']}\n")
            if os.name != "nt":
                file.write("unix_socket_directories=''\n")
        try:
            run("pg_ctl", "-D", data, "-l", log, "-w", "start")
            version = run("psql", "-XAt", "-c", "SHOW server_version")
            if version.split()[0] != SOURCES["postgres"]["version"]:
                raise AssertionError(f"Unexpected server version: {version}")
            run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-c",
                "CREATE EXTENSION vector; CREATE TABLE planted (id integer PRIMARY KEY, embedding vector(3)); "
                "INSERT INTO planted VALUES (428, '[1,2,3]');")
            vector = run("psql", "-XAt", "-c", "SELECT extversion FROM pg_extension WHERE extname='vector'")
            if vector != SOURCES["pgvector"]["version"]:
                raise AssertionError(f"Unexpected vector version: {vector}")
            for compression in ("gzip", "zstd"):
                archive = root / f"planted-{compression}.dump"
                database = f"restored_{compression}"
                run("pg_dump", "--format=custom", f"--compress={compression}:3", "--file", archive, "postgres")
                run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-c", f"CREATE DATABASE {database}")
                run("pg_restore", "--exit-on-error", f"--dbname={database}", archive)
                row = run("psql", "-XAt", f"--dbname={database}", "-c", "SELECT id, embedding FROM planted")
                if row != "428|[1,2,3]":
                    raise AssertionError(f"Restored {compression} row differs: {row}")
                print(f"phase7_pg_bundle PASS: PostgreSQL {version}; vector {vector}; {compression} restored {row}")
        except Exception:
            if log.exists():
                print(log.read_text(errors="replace")[-8000:])
            raise
        finally:
            if (data / "postmaster.pid").exists():
                run("pg_ctl", "-D", data, "-m", "immediate", "-w", "stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    args.scratch.mkdir(parents=True, exist_ok=True)
    proof(args.postgres.resolve(), args.scratch.resolve())


if __name__ == "__main__":
    main()
