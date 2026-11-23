#!/usr/bin/env python3
"""Run one guard-removal probe at a time, restore bytes, then rerun the real CLI suite."""
import os
from pathlib import Path
import subprocess
import tempfile

for name in ("RUSTUP_HOME", "CARGO_TARGET_DIR"):
    if not os.environ.get(name):
        raise SystemExit(f"Set {name} explicitly")
os.environ.update(CARGO_BUILD_JOBS="2", CARGO_PROFILE_DEV_DEBUG="0", CARGO_PROFILE_TEST_DEBUG="0")
base = Path("rust-spike/module-publisher")
host = Path("rust-spike/module-host/src")
artifact = base / "src/artifacts.rs"
registry = base / "src/registry_artifacts.rs"
controls = [
    (host / "archive.rs", "trust::digest(bytes) == expected", "true", ["mirror_refuses_tampered_archive_without_creating_output"]),
    # Removing the final cryptographic guard proves all four signature paths reach it.
    (host / "trust.rs", '''UnparsedPublicKey::new(&ED25519, key)
        .verify(bytes, &sig)
        .map_err(|_| anyhow::anyhow!("The signature does not match; nothing was installed"))''', "Ok(())", ["verify_authenticates_package_and_refuses_tampering", "registry_refuses_tampered_index_signature", "registry_refuses_tampered_identity_signature", "registry_refuses_tampered_detached_package_signature", "bundle_tampering_is_refused"]),
    (registry, "registry::same_publisher(&all, id)?;", "", ["mirror_refuses_cross_registry_publisher_conflicts"]),
    (artifact, "Host::new(Limits::default())?.validate(wasm, &package.manifest)?;", "", ["verify_refuses_undeclared_imports"]),
    (artifact, "sql::check(package, &LegacyInventory::default())?;", "", ["verify_refuses_unsafe_sql_and_wrong_publisher_name"]),
]
logs = Path(os.environ.get("REGISTRY_ARTIFACT_PROOF_DIR") or tempfile.mkdtemp(prefix="moss-artifacts-negative-"))
logs.mkdir(parents=True, exist_ok=True)
command = ["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(base / "Cargo.toml"), "--test", "phase6_registry_artifacts"]
count = 0
for path, anchor, replacement, tests in controls:
    before = path.read_bytes()
    if before.decode().count(anchor) != 1:
        raise SystemExit(f"Expected one mutation anchor in {path}: {anchor!r}")
    try:
        path.write_text(before.decode().replace(anchor, replacement))
        for test in tests:
            result = subprocess.run(command + [test, "--", "--exact", "--nocapture", "--test-threads=1"], capture_output=True, text=True)
            log = result.stdout + result.stderr
            log_path = logs / f"{count + 1:02d}-{test}.txt"
            log_path.write_text(log)
            if result.returncode == 0 or "test result: FAILED. 0 passed; 1 failed" not in log or "Expected refusal:" not in log:
                raise SystemExit(f"Guard removal did not reach a refusal assertion: {log_path}")
            count += 1
            print(f"RED without guard: {test}", flush=True)
    finally:
        path.write_bytes(before)
print(f"All {count} guard-removal probes failed at assertions; sources restored.", flush=True)
subprocess.run(command + ["--", "--test-threads=1"], check=True)
