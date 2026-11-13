#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-connectors-host}"
export CARGO_TARGET_DIR
export CONNECTORS_UI_DIR="${CONNECTORS_UI_DIR:-$CARGO_TARGET_DIR/connectors-ui/web}"
modules/connectors/tools/build-ui.sh
ui_target="$CARGO_TARGET_DIR/connectors-ui"
CARGO_TARGET_DIR="$ui_target" cargo +1.95.0 test --locked --offline --manifest-path modules/connectors/ui/Cargo.toml
guest="$CARGO_TARGET_DIR/connectors-guest"
# Native tests, then the real Wasm build and the same package tests against it.
CARGO_TARGET_DIR="$guest" cargo +1.95.0 test --locked --offline --manifest-path modules/connectors/src/Cargo.toml
CARGO_TARGET_DIR="$guest" cargo +1.95.0 build --locked --offline --manifest-path modules/connectors/src/Cargo.toml --bin connectors-oracle
export CONNECTORS_ORACLE="$guest/debug/connectors-oracle"
pnpm exec tsx modules/connectors/tools/routes-parity.ts
pnpm exec tsx modules/connectors/tools/logic-parity.ts
pnpm exec tsx modules/connectors/tools/google-fixtures.ts --check
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/connectors/src/Cargo.toml
export CONNECTORS_CORE_WASM="$guest/wasm32-unknown-unknown/release/moss_connectors.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/connectors/host/Cargo.toml --test package --test google --test google_sync --test imap --test refresh --test outlook --test mail_probe --test sync_speed --test writes -- --nocapture
