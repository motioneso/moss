#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${CARGO_TARGET_DIR:=/tmp/js48-host-target}"
export CARGO_TARGET_DIR
export CALENDAR_UI_DIR="${CALENDAR_UI_DIR:-$CARGO_TARGET_DIR/calendar-ui/web}"
modules/calendar/tools/build-ui.sh
calendar_ui_target="${CALENDAR_UI_TARGET:-$CARGO_TARGET_DIR/calendar-ui}"
CARGO_TARGET_DIR="$calendar_ui_target" cargo +1.95.0 test --locked --offline --manifest-path modules/calendar/ui/Cargo.toml
CARGO_TARGET_DIR="$calendar_ui_target" cargo +1.95.0 build --locked --offline --manifest-path modules/calendar/ui/Cargo.toml --bin calendar-ui-model
CALENDAR_UI_ORACLE="$calendar_ui_target/debug/calendar-ui-model" pnpm exec tsx modules/calendar/tools/ui-parity.ts
calendar_guest_target="$CARGO_TARGET_DIR/calendar-guest"
export CALENDAR_DATA_ORACLE="$calendar_guest_target/debug/calendar-data-parity"
# Use an already provisioned Rust home when the native installation lacks Wasm.
if [[ -n "${CALENDAR_RUSTUP_HOME:-}" ]]; then export RUSTUP_HOME="$CALENDAR_RUSTUP_HOME"; fi
CARGO_TARGET_DIR="$calendar_guest_target" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --target wasm32-unknown-unknown --manifest-path modules/calendar/src/Cargo.toml
export CALENDAR_CORE_WASM="$calendar_guest_target/wasm32-unknown-unknown/release/moss_calendar.wasm"
CARGO_TARGET_DIR="$calendar_guest_target" cargo +1.95.0 test --locked --offline --manifest-path modules/calendar/src/Cargo.toml
CARGO_TARGET_DIR="$calendar_guest_target" cargo +1.95.0 build --locked --offline --manifest-path modules/calendar/src/Cargo.toml --bin calendar-data-parity
pnpm exec tsx modules/calendar/tools/data-parity.ts
cargo +1.95.0 test --locked --offline --manifest-path modules/calendar/host/Cargo.toml --test package
