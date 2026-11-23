#!/usr/bin/env python3
"""Temporarily remove one protection, demand a red assertion, always restore bytes.

Run from the repository root with no other build/editor using this worktree.
Logs live outside the repository; no production bypass feature is shipped.
"""
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
lib = base / "src/lib.rs"
# Each mutation must reach a test assertion failure, not merely a build error.
controls = [
    (host / "archive.rs", '"moss.module.json", "LICENSE", "NOTICE", "CHANGELOG.md"', '"moss.module.json", "LICENSE", "CHANGELOG.md"', ["bad_archive_is_refused"]),
    (host / "manifest.rs", 'self.schema_version == 2', 'true', ["bad_manifest_is_refused"]),
    (lib, 'Host::new(Limits::default())?.validate(wasm, &package.manifest)?;', '', ["undeclared_import_is_refused", "self_hosted_policy_still_runs_install_checks"]),
    (lib, 'sql::check(&package, &LegacyInventory::default())?;', '', ["bad_sql_is_refused"]),
    (host / "manifest.rs", 'reject_model_fields(&serde_json::to_value(self)?)?;', '', ["provider_model_fields_are_refused"]),
    (host / "trust.rs", 'ensure!(allowed, "The publisher cannot sign this module name");', '', ["wrong_publisher_name_is_refused"]),
    (lib, '''catalog.trust.verify_package(
            &submission.publisher_key,
            &package.manifest.id,
            &digest,
            &submission.signature,
        )?;''', '', ["wrong_publisher_signature_is_refused"]),
    (lib, 'package.manifest.version > previous.version', 'true', ["version_reuse_and_downgrade_are_refused", "newest_signed_version_is_the_baseline"]),
    (lib, 'package.unchanged_sql(&old)?;', '', ["altered_published_sql_is_refused"]),
    (host / "registry.rs", 'trust::verify(key, &bytes, &sig)?;', '', ["tampered_prior_index_is_refused"]),
    (host / "archive.rs", 'trust::digest(bytes) == expected', 'true', ["tampered_prior_package_is_refused"]),
    (host / "registry_review.rs", 'self.new_publisher ||', 'false ||', ["new_publisher_waits_for_human"]),
    (lib, '!matches!(config.policy, Policy::Moss)', 'true', ["new_capability_waits_and_marks_signed_index", "fetch_host_growth_waits_and_is_marked"]),
    (lib, '                capabilities,\n', '                capabilities: Vec::new(),\n', ["new_capability_waits_and_marks_signed_index"]),
    (lib, '                fetch_hosts,\n', '                fetch_hosts: BTreeSet::new(),\n', ["fetch_host_growth_waits_and_is_marked"]),
    (lib, 'approval.request == self.request', 'true', ["approval_digest_mismatch_is_refused", "approval_diff_mismatch_is_refused", "approval_cannot_be_replayed_after_package_or_base_changes"]),
    (lib, '.get(&approval.reviewer)', '.values().next()', ["untrusted_reviewer_is_refused"]),
    (lib, '''trust::verify(
                key,
                &approval_bytes(&approval.request)?,
                &approval.signature,
            )?;''', '', ["forged_human_signature_is_refused"]),
    (host / "manifest.rs", 'self.requires_moss.matches(moss)', 'true', ["incompatible_candidate_is_still_refused"]),
    (lib, 'catalog.trust.identity.id == config.registry_id', 'true', ["wrong_registry_identity_is_refused"]),
    (lib, 'catalog.index.expires > chrono::Utc::now()', 'true', ["expired_base_is_refused"]),
    (lib, 'STANDARD.encode(key.public_key().as_ref()) == *expected', 'true', ["wrong_index_signing_key_is_refused"]),
    (lib, 'bytes.len() as u64 <= limit', 'true', ["oversized_input_is_refused"]),
    (lib, 'index\n            .serial\n            .checked_add(1)\n            .context("Index serial exhausted")?', 'index.serial.wrapping_add(1)', ["exhausted_index_serial_is_refused"]),

    (lib, 'None => manifest.capabilities.clone()', 'None => Vec::new()', ["existing_publisher_new_module_needs_capability_review"]),
    (lib, '.chain(\n            manifest\n                .credentials\n                .values()\n                .flat_map(|c| c.hosts.iter().cloned()),\n        )', '', ["credential_hosts_are_also_diffed"]),
    (lib, '.difference(&old_hosts)', '.union(&old_hosts)', ["unchanged_and_removed_hosts_do_not_grow"]),
    (lib, 'bytes.len() as u64 <= MAX_INDEX', 'true', ["oversized_proposed_index_is_refused"]),
    (lib, '!seen.blocks_package(&digest, &submission.publisher_key, &publisher.key)', 'true', ["blocked_digest_is_refused", "blocked_publisher_is_refused"]),

]
logs = Path(os.environ.get("PUBLISH_REVIEW_PROOF_DIR") or tempfile.mkdtemp(prefix="moss-publish-negative-"))
logs.mkdir(parents=True, exist_ok=True)
command = ["cargo", "+1.95.0", "test", "--locked", "--manifest-path", str(base / "Cargo.toml"), "--test", "phase6_publish_review"]
count = 0
for path, original, replacement, tests in controls:
    before = path.read_bytes()
    source = before.decode()
    if source.count(original) != 1:
        raise SystemExit(f"Mutation anchor must occur exactly once: {path}: {original!r}")
    try:
        path.write_text(source.replace(original, replacement))
        for test in tests:
            result = subprocess.run(command + [test, "--", "--exact", "--nocapture", "--test-threads=1"], capture_output=True, text=True)
            log = result.stdout + result.stderr
            log_path = logs / f"{count + 1:02d}-{test}.log"
            log_path.write_text(log)
            marker_test = test in {"fetch_host_growth_waits_and_is_marked", "credential_hosts_are_also_diffed", "unchanged_and_removed_hosts_do_not_grow"}
            expected_failure = "Expected refusal:" in log or (marker_test and "assertion `left == right` failed" in log)
            if result.returncode == 0 or "test result: FAILED. 0 passed; 1 failed" not in log or not expected_failure:
                raise SystemExit(f"Control did not produce the required assertion failure: {log_path}")
            count += 1
            print(f"RED without guard: {test} ({path.name})", flush=True)
    finally:
        path.write_bytes(before)
print(f"All {count} negative controls failed as required; source restored. Logs: {logs}", flush=True)
# Rebuild restored sources and prove the full CLI suite green once more.
subprocess.run(command + ["--", "--test-threads=1"], check=True)
