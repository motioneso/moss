#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-meetings-host}"
export CARGO_TARGET_DIR
# Native tests, then the real component build and the package tests against it.
CARGO_TARGET_DIR="$CARGO_TARGET_DIR/guest" cargo +1.95.0 test --locked --offline --manifest-path modules/meetings/src/Cargo.toml
modules/meetings/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
export MEETINGS_COMPONENT_WASM="$CARGO_TARGET_DIR/module.wasm"
# The reading tests install the real Memory package next to Meetings.
memory="$CARGO_TARGET_DIR/memory-guest"
CARGO_TARGET_DIR="$memory" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/memory/src/Cargo.toml
cargo +1.95.0 test --locked --offline --manifest-path modules/meetings/host/Cargo.toml --test package
