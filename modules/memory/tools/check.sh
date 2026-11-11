#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-memory-host}"
export CARGO_TARGET_DIR
guest="$CARGO_TARGET_DIR/memory-guest"
# Native tests, then the real Wasm build and the package tests against it.
CARGO_TARGET_DIR="$guest" cargo +1.95.0 test --locked --offline --manifest-path modules/memory/src/Cargo.toml
# The stored score cases must still equal what the old recall code produces.
pnpm exec tsx modules/memory/tools/score-oracle.ts
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/memory/src/Cargo.toml
export MEMORY_CORE_WASM="$guest/wasm32-unknown-unknown/release/moss_memory.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/memory/host/Cargo.toml --test package
