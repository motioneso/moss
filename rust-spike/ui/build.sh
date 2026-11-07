#!/bin/bash
# Usage: build.sh <leptos|dioxus> <out-dir>
# Builds the wasm, runs wasm-bindgen through the helper crate, and writes the CSS, fonts and
# index.html next to it. Needs the task-local wasm toolchain (see README.md).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
: "${RUSTUP_HOME:?set RUSTUP_HOME to the rustup home that has the wasm target (see README.md)}"
export RUSTUP_HOME
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/../target/ui}"
name="$1"; out="$2"
mkdir -p "$out"
(cd bindgen && cargo build --release --quiet)
(cd "$name" && cargo build --release --target wasm32-unknown-unknown --quiet)
"$CARGO_TARGET_DIR/release/ui-bindgen" \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/ui-$name.wasm" "$out" app
python3 assets/build-assets.py "$out"
cp assets/index.html "$out/index.html"
