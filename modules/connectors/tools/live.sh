#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-connectors-host}"
export CARGO_TARGET_DIR
export CONNECTORS_UI_DIR="${CONNECTORS_UI_DIR:-$CARGO_TARGET_DIR/connectors-ui/web}"
modules/connectors/tools/build-ui.sh
guest="$CARGO_TARGET_DIR/connectors-guest"
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/connectors/src/Cargo.toml
CARGO_TARGET_DIR="$guest" cargo +1.95.0 run --locked --offline --manifest-path modules/connectors/host/Cargo.toml --bin connectors-package -- \
  "$guest/wasm32-unknown-unknown/release/moss_connectors.wasm" "$CARGO_TARGET_DIR/connectors.mosspkg"
export JS224_CONNECTORS_PACKAGE="$CARGO_TARGET_DIR/connectors.mosspkg"
pnpm exec tsx modules/connectors/tools/live-gate.ts
