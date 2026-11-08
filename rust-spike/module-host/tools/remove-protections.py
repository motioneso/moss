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
    ("root/index/publisher signature verification", "src/trust.rs", r'pub fn verify\(key: &str, bytes: &\[u8\], signature: &str\) -> Result<\(\)> \{.*?\n\}', 'pub fn verify(_key: &str, _bytes: &[u8], _signature: &str) -> Result<()> { Ok(()) }', "registry", "forged_root_index_and_publisher_signatures_are_refused"),
    ("package hash", "src/archive.rs", r'trust::digest\(bytes\) == expected', "true", "boundaries", "tampered_package_is_refused"),
    ("file/socket/database import allowlist", "src/runtime.rs", r'ensure!\(\s*port.is_some_and[^;]+;', 'let _ = port;', "boundaries", "no_file_socket_or_database_escape_imports"),
    ("publisher prefix", "src/trust.rs", r'ensure!\(allowed, "The publisher cannot sign this module name"\);', 'let _ = allowed;', "registry", "publisher_cannot_escape_prefix_even_with_valid_signature"),
    ("private destination check", "src/registry.rs", r'pub fn public_ip\(ip: IpAddr\) -> bool \{', 'pub fn public_ip(ip: IpAddr) -> bool { return true;', "registry", "private_addresses_are_not_public_destinations"),
    ("native cache authentication", "src/compiled.rs", r'hmac::verify\(&self.key\(\), &message, tag\).ok\(\)\?;', 'let _ = tag;', "boundaries", "authenticated_compile_cache_rebuilds_tampered_native_bytes"),
    ("credential response redaction", "src/credentials.rs", r'sanitize\(&mut value, &fields\);', 'let _ = &fields;', "services", "credential_exchange_and_echo_redaction_use_the_real_guest_and_encrypted_store"),
    ("one-use tool approval", "src/services.rs", r'self.write\(id, access, &key, &Value::Null\)\?;', 'let _ = &key;', "services", "installed_public_apis_events_tool_grants_and_account_routes_use_the_real_host"),

    ("publisher registry provenance", "src/store.rs", r'for \(registry, seen\) in &state\.registries \{.*?\n        \}\n        if let Some\(old\)', 'if let Some(old)', "lifecycle", "sample_install_pin_upgrade_remove_and_reinstall_preserves_account_data"),
    ("host-owned actor and role", "src/runtime.rs", r'reject_context\(&request.parameters\)\?;', 'let _ = &request.parameters;', "boundaries", "guest_cannot_select_another_actor_or_resource"),

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
        if name == "publisher registry provenance":
            changed, extra = re.subn(r'old\.registry == catalog\.trust\.identity\.id\s*&& publisher\.replaces', 'publisher.replaces', changed, count=1)
            if extra != 1:
                raise SystemExit("Control did not find the persisted provenance check")
        path.write_text(changed)
        run = subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(copy / "Cargo.toml"), "--test", suite, test, "--", "--exact"], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
        if run.returncode == 0 or "test result: FAILED" not in run.stdout:
            print(run.stdout[-5000:])
            raise SystemExit(f"Control was not a failing assertion: {name}")
        print(f"PASS removal control: {name} → {test} failed with the protection removed", flush=True)
print("All removal controls failed as expected; the working tree was never mutated.")
