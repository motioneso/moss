#!/usr/bin/env bash
# Builds the real guest, then runs the ignored database tests for the vault index.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-memory-host}"
export CARGO_TARGET_DIR
guest="$CARGO_TARGET_DIR/memory-guest"
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/memory/src/Cargo.toml
export MEMORY_CORE_WASM="$guest/wasm32-unknown-unknown/release/moss_memory.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/memory/host/Cargo.toml --test vault_index -- --ignored --nocapture --test-threads=1
