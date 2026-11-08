#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ -n "${CALENDAR_RUSTUP_HOME:-}" ]]; then export RUSTUP_HOME="$CALENDAR_RUSTUP_HOME"; fi
calendar_ui_target="${CALENDAR_UI_TARGET:-${CARGO_TARGET_DIR:-/tmp/moss-calendar-host}/calendar-ui}"
calendar_ui_out="${CALENDAR_UI_DIR:-$calendar_ui_target/web}"
calendar_bindgen_target="${CALENDAR_BINDGEN_TARGET:-$calendar_ui_target/bindgen}"
CARGO_TARGET_DIR="$calendar_ui_target" cargo +1.95.0 build --locked --offline --release \
  --manifest-path modules/calendar/ui/Cargo.toml --no-default-features --features csr --target wasm32-unknown-unknown --lib
CARGO_TARGET_DIR="$calendar_bindgen_target" cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/ui/bindgen/Cargo.toml
mkdir -p "$calendar_ui_out"
"$calendar_bindgen_target/release/ui-bindgen" "$calendar_ui_target/wasm32-unknown-unknown/release/moss_calendar_ui.wasm" "$calendar_ui_out" calendar
cp modules/calendar/ui/web/{index.html,boot.mjs,bridge.mjs} "$calendar_ui_out/"
cp modules/calendar/ui/web/index.html "$calendar_ui_out/settings.html"
cp rust-spike/module-ui/web/guest-bridge.mjs "$calendar_ui_out/"
cat apps/web/src/styles/kit-calendar.css modules/calendar/ui/web/layout.css > "$calendar_ui_out/calendar.css"
echo "Calendar UI built at $calendar_ui_out"
