#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then echo 'Usage: build.sh output-directory' >&2; exit 2; fi
people_ui_out=$(realpath -m -- "$1")
cd "$(dirname "$0")/../../.."
: "${RUSTUP_HOME:?Use a task-local toolchain with wasm32-unknown-unknown}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/moss-people-ui-target}"
cargo +1.95.0 build --offline --locked --manifest-path modules/people/ui/Cargo.toml --release --target wasm32-unknown-unknown
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/ui/bindgen/Cargo.toml --release
mkdir -p "$people_ui_out"
"$CARGO_TARGET_DIR/release/ui-bindgen" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/moss_people_ui.wasm" "$people_ui_out" people
cp modules/people/ui/web/* "$people_ui_out/"
cp rust-spike/module-ui/web/guest-bridge.mjs "$people_ui_out/"
