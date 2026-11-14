#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-scratchpad-host}"
export CARGO_TARGET_DIR
# Native guest tests, then the real component build and the host tests against it.
CARGO_TARGET_DIR="$CARGO_TARGET_DIR/guest" cargo +1.95.0 test --locked --offline --manifest-path modules/scratchpad/src/Cargo.toml
modules/scratchpad/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
export SCRATCHPAD_COMPONENT_WASM="$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/scratchpad/host/Cargo.toml
