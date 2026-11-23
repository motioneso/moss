#!/usr/bin/env python3
"""Sequential refusal probes. Never run concurrently with another Cargo invocation."""
import os
from pathlib import Path
import subprocess
import tempfile

for name in ("RUSTUP_HOME", "CARGO_TARGET_DIR"):
    if not os.environ.get(name):
        raise SystemExit(f"Set {name} explicitly")
os.environ.update(CARGO_BUILD_JOBS="2", CARGO_PROFILE_DEV_DEBUG="0", CARGO_PROFILE_TEST_DEBUG="0")
base = Path("rust-spike/module-publisher")
host = Path("rust-spike/module-host")
bundle = host / "src/bundle.rs"
controls = [
    (host / "src/archive.rs", "trust::digest(bytes) == expected", "true", host, "phase6_offline_bundle", "bundled_bytes_need_the_compiled_digest_and_signature"),
    (bundle, "trust::verify(first_party_key, entry.digest.as_bytes(), entry.signature)?;", "", host, "phase6_offline_bundle", "bundled_bytes_need_the_compiled_digest_and_signature"),
    (bundle, "!state.installed.contains_key(entry.id) && !state.retained.contains_key(entry.id)", "true", host, "phase6_offline_bundle", "bootstrap_cannot_replace_an_install_or_bypass_an_observed_registry"),
    (bundle, 'state.registries.is_empty(),\n            "Use the registry after its first refresh"', 'true,\n            "Use the registry after its first refresh"', host, "phase6_offline_bundle", "bootstrap_cannot_replace_an_install_or_bypass_an_observed_registry"),
    (bundle, "self.admin(access)?;", "", host, "phase6_offline_bundle", "bootstrap_requires_an_admin_the_named_module_and_its_dependencies"),
    (bundle, "package.manifest.id == entry.id && !entry.id.contains('.')", "true", host, "phase6_offline_bundle", "bootstrap_requires_an_admin_the_named_module_and_its_dependencies"),
    (bundle, 'state\n                    .installed\n                    .get(id)\n                    .is_some_and(|m| range.matches(&m.manifest.version))', "true", host, "phase6_offline_bundle", "bootstrap_requires_an_admin_the_named_module_and_its_dependencies"),
    (base / "src/release.rs", 'std::env::var("MOSS_RUST_REGISTRY_APPROVED_REPORT").ok().as_deref()==Some(approved_digest.as_str())', "true", base, "phase6_release", "production_release_requires_the_exact_human_review_report"),
    (bundle, "package.manifest.id == item.package.id && !item.package.id.contains('.')", "true", host, "phase6_offline_bundle", "optional::optional_bytes_are_validated_before_caching"),
    (bundle, 'trust::verify(\n                self.first_party_key,\n                item.package.digest.as_bytes(),\n                item.package.signature,\n            )?;', "", host, "phase6_offline_bundle", "optional::optional_bytes_are_validated_before_caching"),
    (bundle, 'crate::sql::check(&package, &installer.inventory)?;', "", host, "phase6_offline_bundle", "optional::optional_bytes_are_validated_before_caching"),
    (bundle, 'installer.host.validate(wasm, &package.manifest)?;', "", host, "phase6_offline_bundle", "optional::optional_bytes_are_validated_before_caching"),
]
logs = Path(os.environ.get("RELEASE_PROOF_DIR") or tempfile.mkdtemp(prefix="moss-release-negative-"))
logs.mkdir(parents=True, exist_ok=True)
for number, (path, anchor, replacement, crate, suite, test) in enumerate(controls, 1):
    before = path.read_bytes()
    if before.decode().count(anchor) != 1:
        raise SystemExit(f"Expected exactly one mutation anchor in {path}: {anchor!r}")
    try:
        path.write_text(before.decode().replace(anchor, replacement))
        result = subprocess.run(["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(crate / "Cargo.toml"), "--test", suite, test, "--", "--exact", "--nocapture", "--test-threads=1"], capture_output=True, text=True)
        log = result.stdout + result.stderr
        log_path = logs / f"{number:02d}-{test}.txt"
        log_path.write_text(log)
        if result.returncode == 0 or "test result: FAILED. 0 passed; 1 failed" not in log or "Expected refusal:" not in log:
            raise SystemExit(f"Guard removal did not reach a refusal assertion: {log_path}")
        print(f"RED without guard: {number} {test}", flush=True)
    finally:
        path.write_bytes(before)
path = base / "tools/release_transport.py"
before = path.read_bytes()
try:
    anchor = 'os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"'
    assert before.decode().count(anchor) == 1
    path.write_text(before.decode().replace(anchor, "False"))
    result = subprocess.run(["python3", str(base / "tools/test_release_transport.py"), "Publication.test_non_dispatch_cannot_publish"], capture_output=True, text=True)
    log = result.stdout + result.stderr
    (logs / "09-dispatch.txt").write_text(log)
    assert result.returncode != 0 and "Expected refusal:" in log and "FAIL:" in log, log
    print("RED without guard: manual dispatch", flush=True)
finally:
    path.write_bytes(before)
print("All thirteen refusal controls failed at assertions; sources restored.", flush=True)
subprocess.run(["bash", str(base / "tools/release-check.sh")], check=True, env=os.environ | {"MOSS_RELEASE_SKIP_NEGATIVE_CONTROLS": "1"})
