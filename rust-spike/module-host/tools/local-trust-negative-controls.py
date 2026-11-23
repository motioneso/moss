#!/usr/bin/env python3
"""Transiently remove each guard; require a test assertion failure, then restore sources."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
local = root / "rust-spike/module-host/src/local_packages.rs"
archive = root / "rust-spike/module-host/src/archive.rs"
trust = root / "rust-spike/module-host/src/trust.rs"
keystore = root / "rust-spike/keystore/src/store.rs"
controls = [
    (keystore, 'let encrypted = cipher.encrypt_json(payload.as_object().unwrap());', 'let encrypted = payload.clone();', 'encrypted_key_is_retained_and_damage_does_not_rotate_it'),
    (local, 'signature.installation_id == identity.installation_id', 'true', 'install_label_cannot_be_renamed'),
    (local, 'signature.key_fingerprint == identity.fingerprint', 'true', 'key_label_cannot_be_renamed'),
    (local, 'package.manifest.id.starts_with(&prefix)', 'true', 'renamed_owner_is_refused_even_for_the_same_install'),
    (local, 'package.manifest.id.starts_with(&prefix)', 'true', 'renamed_prefix_is_refused_even_with_a_valid_local_signature'),
    (local, 'trust::verify(\n            &identity.public_key,\n            signature.digest.as_bytes(),\n            &signature.signature,\n        )?;', '', 'wrong_key_is_refused_even_with_this_installs_labels'),
    (archive, 'trust::digest(bytes) == expected', 'true', 'changed_bytes_are_refused'),
    (archive, 'host.validate(wasm, &package.manifest)?;', '', 'undeclared_import_is_refused_even_when_signed'),
    (archive, 'crate::sql::check(package, inventory)?;', '', 'invalid_sql_is_refused_even_when_signed'),
    (trust, '!module_id.starts_with("local.")', 'true', 'local_namespace_cannot_claim_registry_review'),
]
assert os.environ.get('CARGO_TARGET_DIR'), 'Set an isolated CARGO_TARGET_DIR'
assert os.environ.get('RUSTUP_HOME'), 'Set RUSTUP_HOME explicitly'
env = dict(os.environ, CARGO_BUILD_JOBS='2', CARGO_PROFILE_DEV_DEBUG='0', CARGO_PROFILE_TEST_DEBUG='0')
command = ['cargo', '+1.95.0', 'test', '--offline', '--locked', '--manifest-path', str(root / 'rust-spike/module-host/Cargo.toml'), '--test', 'phase6_local_trust']
for path, old, new, test in controls:
    original = path.read_text()
    assert original.count(old) == 1, (path, old)
    try:
        path.write_text(original.replace(old, new))
        result = subprocess.run(command + [test, '--', '--exact'], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if result.returncode == 0 or 'test result: FAILED' not in result.stdout:
            print(result.stdout[-6000:])
            sys.exit(f'Control did not fail its assertion: {test}')
        print(f'Guard removed: {test}: assertion FAILED as required', flush=True)
    finally:
        path.write_text(original)
subprocess.run(command, cwd=root, env=env, check=True)
print('All local trust controls failed with guards removed; restored suite passed.', flush=True)
