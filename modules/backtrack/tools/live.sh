#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-backtrack-host}"
export CARGO_TARGET_DIR
guest="$CARGO_TARGET_DIR/memory-guest"
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/memory/src/Cargo.toml
CARGO_TARGET_DIR="$guest" cargo +1.95.0 run --locked --offline --manifest-path modules/memory/host/Cargo.toml --bin memory-package -- \
  "$guest/wasm32-unknown-unknown/release/moss_memory.wasm" "$CARGO_TARGET_DIR/memory.mosspkg"
export JS231_MEMORY_PACKAGE="$CARGO_TARGET_DIR/memory.mosspkg"
modules/backtrack/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/backtrack/host/Cargo.toml --bin backtrack-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/backtrack.mosspkg"
export JS261_BACKTRACK_PACKAGE="$CARGO_TARGET_DIR/backtrack.mosspkg"
pnpm exec tsx modules/backtrack/tools/live-gate.ts
