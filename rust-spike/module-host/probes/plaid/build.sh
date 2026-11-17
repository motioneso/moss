#!/usr/bin/env bash
# Builds the test-only Plaid probe guest as a WebAssembly component. Usage: build.sh <out.wasm>
set -euo pipefail
cd "$(dirname "$0")/../../../.."
target_dir="${CARGO_TARGET_DIR:-$PWD/rust-spike/module-host/probes/plaid/target}"
CARGO_TARGET_DIR="$target_dir" cargo +1.95.0 build --locked --offline --manifest-path rust-spike/module-host/probes/plaid/Cargo.toml \
  --target wasm32-unknown-unknown --release
CARGO_TARGET_DIR="$target_dir/component-encoder" cargo +1.95.0 run --locked --offline \
  --manifest-path modules/web-research/bindings/Cargo.toml --bin web-research-component -- \
  "$target_dir/wasm32-unknown-unknown/release/moss_plaid_probe.wasm" "$1"
