#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-email-host}"
export CARGO_TARGET_DIR
export EMAIL_UI_DIR="${EMAIL_UI_DIR:-$CARGO_TARGET_DIR/email-ui/web}"
modules/email/tools/build-ui.sh
ui_target="$CARGO_TARGET_DIR/email-ui"
CARGO_TARGET_DIR="$ui_target" cargo +1.95.0 test --locked --offline --manifest-path modules/email/ui/Cargo.toml
guest="$CARGO_TARGET_DIR/email-guest"
# Native tests, then the real Wasm build and the same package tests against it.
CARGO_TARGET_DIR="$guest" cargo +1.95.0 test --locked --offline --manifest-path modules/email/src/Cargo.toml
CARGO_TARGET_DIR="$guest" cargo +1.95.0 build --locked --offline --manifest-path modules/email/src/Cargo.toml --bin email-oracle
export EMAIL_ORACLE="$guest/debug/email-oracle"
pnpm exec tsx modules/email/tools/routes-parity.ts
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/email/src/Cargo.toml
export EMAIL_CORE_WASM="$guest/wasm32-unknown-unknown/release/moss_email.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/email/host/Cargo.toml --test package
