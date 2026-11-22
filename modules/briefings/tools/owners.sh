#!/usr/bin/env bash
# Builds the Tasks, Calendar and Email packages for the source switches proof and exports their
# paths. Calendar needs Tasks. Source this from live.sh after CARGO_TARGET_DIR is set.
set -euo pipefail
wasm_flags='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864'
tasks_out="$CARGO_TARGET_DIR/tasks-pkg"
mkdir -p "$tasks_out"
TASKS_GUEST_TARGET_DIR="$CARGO_TARGET_DIR/tasks-guest" bash modules/tasks/tools/build-component.sh "$tasks_out/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-pack -- \
  "$tasks_out/module.wasm" "$CARGO_TARGET_DIR/tasks.mosspkg"
export JS378_TASKS_PACKAGE="$CARGO_TARGET_DIR/tasks.mosspkg"
export CALENDAR_UI_DIR="$CARGO_TARGET_DIR/calendar-ui/web"
modules/calendar/tools/build-ui.sh
cguest="$CARGO_TARGET_DIR/calendar-guest-pkg"
CARGO_TARGET_DIR="$cguest" RUSTFLAGS="$wasm_flags" cargo +1.95.0 build --locked --offline --release --lib \
  --target wasm32-unknown-unknown --manifest-path modules/calendar/src/Cargo.toml
CARGO_TARGET_DIR="$cguest" cargo +1.95.0 run --locked --offline --manifest-path modules/calendar/host/Cargo.toml \
  --bin calendar-package -- "$cguest/wasm32-unknown-unknown/release/moss_calendar.wasm" "$CARGO_TARGET_DIR/calendar.mosspkg"
export JS378_CALENDAR_PACKAGE="$CARGO_TARGET_DIR/calendar.mosspkg"
export EMAIL_UI_DIR="$CARGO_TARGET_DIR/email-ui/web"
modules/email/tools/build-ui.sh
eguest="$CARGO_TARGET_DIR/email-guest"
CARGO_TARGET_DIR="$eguest" RUSTFLAGS="$wasm_flags" cargo +1.95.0 build --locked --offline --release --lib \
  --target wasm32-unknown-unknown --manifest-path modules/email/src/Cargo.toml
CARGO_TARGET_DIR="$eguest" cargo +1.95.0 run --locked --offline --manifest-path modules/email/host/Cargo.toml \
  --bin email-package -- "$eguest/wasm32-unknown-unknown/release/moss_email.wasm" "$CARGO_TARGET_DIR/email.mosspkg"
export JS378_EMAIL_PACKAGE="$CARGO_TARGET_DIR/email.mosspkg"

# Optional. With BRIEFINGS_SCREEN=1 the held-open server also serves the built app, so a browser can
# open the settings screens.
if [[ "${BRIEFINGS_SCREEN:-}" == 1 ]]; then
  export MOSS_SHELL_WEB_DIR="$CARGO_TARGET_DIR/screen-web"
  cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/ui/bindgen/Cargo.toml
  cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/shell/Cargo.toml -p moss-shell-ui --target wasm32-unknown-unknown
  mkdir -p "$MOSS_SHELL_WEB_DIR"
  "$CARGO_TARGET_DIR/release/ui-bindgen" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/moss-shell-ui.wasm" "$MOSS_SHELL_WEB_DIR" app
  python3 rust-spike/shell/assets/build-assets.py "$MOSS_SHELL_WEB_DIR"
  python3 rust-spike/module-ui/build-assets.py "$MOSS_SHELL_WEB_DIR/module-shared"
  cp rust-spike/shell/assets/index.html "$MOSS_SHELL_WEB_DIR/index.html"
fi
