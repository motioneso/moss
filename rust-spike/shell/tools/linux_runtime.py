"""Unsigned Linux linked-library closure from trusted build-machine binaries.

This is not the native WebKit app closure or a cross-distribution installer. The target
needs the build platform's ELF interpreter ABI and /bin/sh. ldd executes trusted inputs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def elf(path: Path) -> bool:
    if not path.is_file():
        return False
    with path.open("rb") as stream:
        return stream.read(4) == b"\x7fELF"


def dependencies(path: Path, library_path: Path | None = None) -> list[Path]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("LD_")}
    if library_path is not None:
        env["LD_LIBRARY_PATH"] = str(library_path)
    result = subprocess.run(["ldd", str(path)], env=env, text=True, capture_output=True)
    if result.returncode or "not found" in result.stdout:
        raise ValueError(f"Unresolved ELF dependencies for {path.name}: {result.stdout}{result.stderr}")
    return [Path(match) for match in re.findall(r"(?:=>\s+|^\s*)(/\S+)\s+\(", result.stdout, re.M)]


def stage_runtime(install: Path, openssl: Path, ca_bundle: Path) -> None:
    runtime = install / "runtime"
    libraries = runtime / "lib"
    libraries.mkdir(parents=True)
    (runtime / "bin").mkdir()
    (runtime / "ssl").mkdir()
    if not elf(openssl):
        raise ValueError("OpenSSL must be a trusted Linux ELF executable")
    shutil.copy2(openssl, runtime / "bin/openssl")
    # Do not copy the build machine's OpenSSL configuration, engines or private keys.
    # The default provider used for local certificates is built into OpenSSL 3.
    (runtime / "ssl/openssl.cnf").write_text("# Moss local certificate generation uses the default provider.\n")
    ca_bytes = ca_bundle.read_bytes()
    if b"-----BEGIN CERTIFICATE-----" not in ca_bytes or b"PRIVATE KEY-----" in ca_bytes:
        raise ValueError("Expected a PEM public certificate bundle")
    shutil.copy2(ca_bundle, runtime / "ssl/ca-certificates.crt")
    # Phase 1 requires libc C.UTF-8 even when ICU owns collation. glibc loads this
    # data at runtime; it is not visible in an ELF dependency list.
    locale = Path("/usr/lib/locale/C.utf8")
    if not locale.is_dir():
        raise ValueError("Build platform has no C.utf8 locale data for PostgreSQL")
    shutil.copytree(locale, runtime / "locale/C.utf8")
    programs = [install / name for name in ("moss-app", "moss-shell", "moss-db")]
    programs += [runtime / "bin/openssl"]
    # PostgreSQL extensions are dlopen inputs, so ldd on postgres alone is insufficient.
    programs += [path for path in (install / "postgres").rglob("*") if elf(path)]
    interpreters = set()
    for program in programs:
        if not elf(program):
            raise ValueError(f"Expected a Linux ELF program: {program.name}")
        for dependency in dependencies(program, install / "postgres/lib"):
            target = libraries / dependency.name
            if target.exists():
                if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(dependency.read_bytes()).digest():
                    raise ValueError(f"Conflicting runtime library: {dependency.name}")
            else:
                shutil.copy2(dependency, target)
            if dependency.name.startswith("ld-linux"):
                interpreters.add(str(dependency))
    (runtime / "closure.json").write_text(json.dumps({
        "format": 1,
        "scope": "linux-linked-elf",
        "not_included": ["native WebKit helpers and desktop resources"],
        "kernel_interpreters": sorted(interpreters),
        "requires": ["build-platform ELF interpreter ABI", "/bin/sh"],
        "libraries": sorted(path.name for path in libraries.iterdir()),
    }, indent=2) + "\n")
    # Keep real binary names and /proc identities intact: never execute via ld-linux.
    # No inherited library search path is allowed to select a different bundled dependency.
    launcher = install / "moss-run"
    launcher.write_text('''#!/bin/sh
set -eu
case "$0" in */*) script=$0 ;; *) script=$(command -v "$0") ;; esac
root=$(CDPATH= cd -- "${script%/*}" && pwd -P)
export LD_LIBRARY_PATH="$root/runtime/lib:$root/postgres/lib"
unset LD_PRELOAD LD_AUDIT
export PATH="$root/runtime/bin:${PATH:-/usr/bin:/bin}"
export OPENSSL_CONF="$root/runtime/ssl/openssl.cnf"
export SSL_CERT_FILE="$root/runtime/ssl/ca-certificates.crt"
export SSL_CERT_DIR="$root/runtime/ssl"
export LOCPATH="$root/runtime/locale"
case "${1-}" in
  moss-app|moss-shell|moss-db) program=$1; shift; exec "$root/$program" "$@" ;;
  openssl) shift; exec "$root/runtime/bin/openssl" "$@" ;;
  *) echo "usage: moss-run {moss-app|moss-shell|moss-db|openssl} [arguments...]" >&2; exit 2 ;;
esac
''')
    launcher.chmod(0o755)
