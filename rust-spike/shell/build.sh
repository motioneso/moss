#!/bin/bash
# Usage: build.sh [out-dir]
# Builds the Leptos UI to wasm, runs wasm-bindgen through rust-spike/ui/bindgen, copies the
# current app's CSS, fonts and boot script, then builds the server (moss-shell) and the desktop
# app (moss-app). The web build lands in <out-dir>/web next to both programs, where they look
# for it by default.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
: "${RUSTUP_HOME:?set RUSTUP_HOME to a rustup home that has the wasm32-unknown-unknown target (see README.md)}"
export RUSTUP_HOME
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/../target/shell}"
out="${1:-$CARGO_TARGET_DIR/dist}"
web="$out/web"
mkdir -p "$web"
(cd ../ui/bindgen && cargo build --release --quiet)
cargo build --release --quiet -p moss-shell-ui --target wasm32-unknown-unknown
"$CARGO_TARGET_DIR/release/ui-bindgen" \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/moss-shell-ui.wasm" "$web" app
python3 assets/build-assets.py "$web"
cp assets/index.html "$web/index.html"
cargo build --release --quiet -p moss-shell -p moss-app
cp "$CARGO_TARGET_DIR/release/moss-shell" "$CARGO_TARGET_DIR/release/moss-app" "$out/"
echo "built $out/moss-shell, $out/moss-app and $web"
