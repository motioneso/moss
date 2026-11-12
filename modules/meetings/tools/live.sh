#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-meetings-host}"
export CARGO_TARGET_DIR
modules/meetings/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/meetings/host/Cargo.toml --bin meetings-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/meetings.mosspkg"
export JS235_MEETINGS_PACKAGE="$CARGO_TARGET_DIR/meetings.mosspkg"
# Meetings requires Calendar, People and Memory. Calendar and People are empty stand-ins and
# Memory is the real package.
for id in calendar people; do
  cargo +1.95.0 run --locked --offline --manifest-path modules/meetings/host/Cargo.toml --bin meetings-package -- \
    --stand-in "$id" "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/$id.mosspkg"
done
export JS235_CALENDAR_STAND_IN="$CARGO_TARGET_DIR/calendar.mosspkg"
export JS235_PEOPLE_STAND_IN="$CARGO_TARGET_DIR/people.mosspkg"
guest="$CARGO_TARGET_DIR/memory-guest"
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/memory/src/Cargo.toml
CARGO_TARGET_DIR="$guest" cargo +1.95.0 run --locked --offline --manifest-path modules/memory/host/Cargo.toml --bin memory-package -- \
  "$guest/wasm32-unknown-unknown/release/moss_memory.wasm" "$CARGO_TARGET_DIR/memory.mosspkg"
export JS231_MEMORY_PACKAGE="$CARGO_TARGET_DIR/memory.mosspkg"
pnpm exec tsx modules/meetings/tools/live-gate.ts
