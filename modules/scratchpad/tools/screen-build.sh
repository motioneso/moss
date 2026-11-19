#!/usr/bin/env bash
# Builds the actual Rust shell UI used for the Scratchpad screen proof. No desktop build.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${CARGO_HOME:?Set CARGO_HOME}"
: "${RUSTUP_HOME:?Set RUSTUP_HOME}"
: "${CARGO_TARGET_DIR:?Set CARGO_TARGET_DIR}"
: "${MOSS_SCRATCHPAD_SCREEN_WEB:?Set the proof web directory}"
cargo +1.95.0 build --locked --offline --manifest-path rust-spike/shell/Cargo.toml -p moss-shell-ui --target wasm32-unknown-unknown
cargo +1.95.0 build --locked --offline --manifest-path rust-spike/ui/bindgen/Cargo.toml
mkdir -p "$MOSS_SCRATCHPAD_SCREEN_WEB"
"$CARGO_TARGET_DIR/debug/ui-bindgen" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/moss-shell-ui.wasm" "$MOSS_SCRATCHPAD_SCREEN_WEB" app
python3 rust-spike/shell/assets/build-assets.py "$MOSS_SCRATCHPAD_SCREEN_WEB"
python3 rust-spike/module-ui/build-assets.py "$MOSS_SCRATCHPAD_SCREEN_WEB/module-shared"
cp rust-spike/shell/assets/index.html "$MOSS_SCRATCHPAD_SCREEN_WEB/index.html"
