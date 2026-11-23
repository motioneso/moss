#!/usr/bin/env bash
set -euo pipefail
: "${RUSTUP_HOME:?Set RUSTUP_HOME explicitly}"
: "${CARGO_TARGET_DIR:?Use an isolated CARGO_TARGET_DIR}"
export PYTHONDONTWRITEBYTECODE=1
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cargo +1.95.0 test --locked --manifest-path rust-spike/module-host/Cargo.toml --test phase6_offline_bundle -- --test-threads=1
MOSS_RELEASE_FIXTURE_OUTPUT="$scratch/release" cargo +1.95.0 test --locked --manifest-path rust-spike/module-publisher/Cargo.toml --test phase6_release -- --test-threads=1
python3 rust-spike/module-publisher/tools/test_release_transport.py
python3 rust-spike/module-publisher/tools/test_previous_snapshot.py
MOSS_COMPILED_BUNDLE="$scratch/release/compiled_bundle.rs" cargo +1.95.0 build --locked --manifest-path rust-spike/module-publisher/Cargo.toml --bin moss-bundle-bootstrap
python3 - "$scratch/release/registry/index.json" <<'PYTHON'
import datetime, json, sys
expiry=datetime.datetime.fromisoformat(json.load(open(sys.argv[1]))["expires"].replace("Z", "+00:00"))
assert expiry < datetime.datetime.now(datetime.timezone.utc)
print("Executable fixture index already expired:", expiry.isoformat())
PYTHON
# Remove all source package bytes: runtime must use only its compiled bundle.
rm -rf "$scratch/release"
if [ "$(uname -s)" = Linux ]; then
  cc -Wall -Werror rust-spike/module-publisher/tools/network-off.c -o "$scratch/network-off"
  "$scratch/network-off" python3 -c 'import socket, errno
try: socket.socket()
except OSError as error:
 assert error.errno == errno.ENETDOWN, error
 print("Socket creation refused with ENETDOWN")
else: raise AssertionError("Network denial is not active")'
  "$scratch/network-off" "$CARGO_TARGET_DIR/debug/moss-bundle-bootstrap" "$scratch/data" 00000000-0000-0000-0000-000000000001 > "$scratch/bootstrap.json"
  cat "$scratch/bootstrap.json"
  python3 - "$scratch/bootstrap.json" <<'PY'
import json, sys
result=json.load(open(sys.argv[1]))
assert result["installed"] == ["tasks"], result
assert sorted(result["cached"]) == ["finance", "meals", "tasks"], result
assert result["registryObserved"] is False, result
print("Compiled offline bootstrap installed tasks and cached optional finance/meals")
PY
fi
if [ "${MOSS_RELEASE_SKIP_NEGATIVE_CONTROLS:-0}" != 1 ]; then
  python3 rust-spike/module-publisher/tools/release-negative-controls.py
fi
