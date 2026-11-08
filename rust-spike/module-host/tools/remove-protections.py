#!/usr/bin/env python3
"""Removal controls run only in disposable copies; no bypass switches ship in the host."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import uuid

source = Path(__file__).resolve().parents[1]
controls = [
    ("package hash", "src/archive.rs", r'trust::digest\(bytes\) == expected', "true", "boundaries", "tampered_package_is_refused"),
    ("file/socket/database import allowlist", "src/runtime.rs", r'ensure!\(\s*port.is_some_and[^;]+;', 'let _ = port;', "boundaries", "no_file_socket_or_database_escape_imports"),
    ("publisher prefix", "src/trust.rs", r'ensure!\(allowed, "The publisher cannot sign this module name"\);', 'let _ = allowed;', "registry", "publisher_cannot_escape_prefix_even_with_valid_signature"),
    ("private destination check", "src/registry.rs", r'pub fn public_ip\(ip: IpAddr\) -> bool \{', 'pub fn public_ip(ip: IpAddr) -> bool { return true;', "registry", "private_addresses_are_not_public_destinations"),
]
environment = dict(os.environ, CARGO_TARGET_DIR=os.environ.get("CARGO_TARGET_DIR", str(Path(tempfile.gettempdir()) / "moss-module-host-target")))
for name, file, pattern, replacement, suite, test in controls:
    with tempfile.TemporaryDirectory(prefix=".js43-control-", dir=source.parent) as scratch:
        copy = Path(scratch)
        shutil.copytree(source, copy, dirs_exist_ok=True, ignore=shutil.ignore_patterns("target"))
        # Reuse dependency builds without sharing this crate's output filenames with the
        # protected build. Cargo releases its build lock before executing a test binary.
        # A concurrent protected build must never replace the mutated binary being tested.
        package_name = "moss-module-host-control-" + uuid.uuid4().hex
        for filename in ("Cargo.toml", "Cargo.lock"):
            package_file = copy / filename
            package_file.write_text(package_file.read_text().replace(
                'name = "moss-module-host"', f'name = "{package_name}"', 1))
        with (copy / "Cargo.toml").open("a") as manifest:
            manifest.write('\n[lib]\nname = "moss_module_host"\n')
        path = copy / file
        changed, count = re.subn(pattern, replacement, path.read_text(), count=1, flags=re.S)
        if count != 1:
            raise SystemExit(f"Control did not find its protection: {name}")
        path.write_text(changed)
        run = subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(copy / "Cargo.toml"), "--test", suite, test, "--", "--exact"], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
        if run.returncode == 0 or "test result: FAILED" not in run.stdout:
            print(run.stdout[-5000:])
            raise SystemExit(f"Control was not a failing assertion: {name}")
        print(f"PASS removal control: {name} → {test} failed with the protection removed", flush=True)
print("All removal controls failed as expected; the working tree was never mutated.")
