#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-briefings-host}"
export CARGO_TARGET_DIR
# Native tests, then the real component build and the package tests against it.
CARGO_TARGET_DIR="$CARGO_TARGET_DIR/guest" cargo +1.95.0 test --locked --offline --manifest-path modules/briefings/src/Cargo.toml
modules/briefings/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
export BRIEFINGS_COMPONENT_WASM="$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/briefings/host/Cargo.toml --test package
