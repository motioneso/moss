#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_HOME:?Set CARGO_HOME}"
: "${RUSTUP_HOME:?Set RUSTUP_HOME}"
: "${CARGO_TARGET_DIR:=/tmp/moss-commitments-screen}"
export CARGO_TARGET_DIR
# Build the unchanged source packages that supply real cached demo email.
export EMAIL_BINDGEN_TARGET="$CARGO_TARGET_DIR"
export CONNECTORS_BINDGEN_TARGET="$CARGO_TARGET_DIR"
export EMAIL_UI_DIR="$CARGO_TARGET_DIR/email-ui/web"
modules/email/tools/build-ui.sh
export CONNECTORS_UI_DIR="$CARGO_TARGET_DIR/connectors-ui/web"
modules/connectors/tools/build-ui.sh
for module in email connectors; do
  guest="$CARGO_TARGET_DIR/$module-guest"
  CARGO_TARGET_DIR="$guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
    cargo +1.95.0 build --locked --offline --release --lib --target wasm32-unknown-unknown --manifest-path "modules/$module/src/Cargo.toml"
  cargo +1.95.0 run --locked --offline --manifest-path "modules/$module/host/Cargo.toml" --bin "$module-package" -- \
    "$guest/wasm32-unknown-unknown/release/moss_$module.wasm" "$CARGO_TARGET_DIR/$module.mosspkg"
done
export JS225_EMAIL_PACKAGE="$CARGO_TARGET_DIR/email.mosspkg"
export JS224_CONNECTORS_PACKAGE="$CARGO_TARGET_DIR/connectors.mosspkg"
export MOSS_SHELL_WEB_DIR="$CARGO_TARGET_DIR/screen-web"
cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/ui/bindgen/Cargo.toml
cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/shell/Cargo.toml -p moss-shell-ui --target wasm32-unknown-unknown
mkdir -p "$MOSS_SHELL_WEB_DIR"
"$CARGO_TARGET_DIR/release/ui-bindgen" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/moss-shell-ui.wasm" "$MOSS_SHELL_WEB_DIR" app
python3 rust-spike/shell/assets/build-assets.py "$MOSS_SHELL_WEB_DIR"
python3 rust-spike/module-ui/build-assets.py "$MOSS_SHELL_WEB_DIR/module-shared"
cp rust-spike/shell/assets/index.html "$MOSS_SHELL_WEB_DIR/index.html"
export COMMITMENTS_SCREEN_LIVE=1
modules/commitments/tools/live.sh
