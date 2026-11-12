#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-connectors-host}"
export CARGO_TARGET_DIR
export CONNECTORS_UI_DIR="${CONNECTORS_UI_DIR:-$CARGO_TARGET_DIR/connectors-ui/web}"
modules/connectors/tools/build-ui.sh
# The sync writes through Email and Calendar, so the live run installs them too.
export CALENDAR_UI_DIR="${CALENDAR_UI_DIR:-$CARGO_TARGET_DIR/calendar-ui/web}"
modules/calendar/tools/build-ui.sh
cguest="$CARGO_TARGET_DIR/calendar-guest-pkg"
CARGO_TARGET_DIR="$cguest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/calendar/src/Cargo.toml
CARGO_TARGET_DIR="$cguest" cargo +1.95.0 run --locked --offline --manifest-path modules/calendar/host/Cargo.toml --bin calendar-package -- \
  "$cguest/wasm32-unknown-unknown/release/moss_calendar.wasm" "$CARGO_TARGET_DIR/calendar.mosspkg"
export JS181_CALENDAR_PACKAGE="$CARGO_TARGET_DIR/calendar.mosspkg"
export EMAIL_UI_DIR="${EMAIL_UI_DIR:-$CARGO_TARGET_DIR/email-ui/web}"
modules/email/tools/build-ui.sh
eguest="$CARGO_TARGET_DIR/email-guest"
CARGO_TARGET_DIR="$eguest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/email/src/Cargo.toml
CARGO_TARGET_DIR="$eguest" cargo +1.95.0 run --locked --offline --manifest-path modules/email/host/Cargo.toml --bin email-package -- \
  "$eguest/wasm32-unknown-unknown/release/moss_email.wasm" "$CARGO_TARGET_DIR/email.mosspkg"
export JS225_EMAIL_PACKAGE="$CARGO_TARGET_DIR/email.mosspkg"
guest="$CARGO_TARGET_DIR/connectors-guest"
CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
  cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path modules/connectors/src/Cargo.toml
CARGO_TARGET_DIR="$guest" cargo +1.95.0 run --locked --offline --manifest-path modules/connectors/host/Cargo.toml --bin connectors-package -- \
  "$guest/wasm32-unknown-unknown/release/moss_connectors.wasm" "$CARGO_TARGET_DIR/connectors.mosspkg"
export JS224_CONNECTORS_PACKAGE="$CARGO_TARGET_DIR/connectors.mosspkg"
pnpm exec tsx modules/connectors/tools/live-gate.ts
