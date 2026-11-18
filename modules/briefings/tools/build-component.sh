#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ $# != 1 ]]; then
  echo 'Usage: modules/briefings/tools/build-component.sh <output.wasm>' >&2
  exit 2
fi
target_dir="${BRIEFINGS_GUEST_TARGET_DIR:-${CARGO_TARGET_DIR:-$PWD/modules/briefings/src/target}}"
CARGO_TARGET_DIR="$target_dir" cargo +1.95.0 build --locked --offline --manifest-path modules/briefings/src/Cargo.toml \
  --target wasm32-unknown-unknown --release
CARGO_TARGET_DIR="$target_dir/component-encoder" cargo +1.95.0 run --locked --offline \
  --manifest-path modules/briefings/bindings/Cargo.toml \
  --bin briefings-component -- \
  "$target_dir/wasm32-unknown-unknown/release/moss_briefings_module.wasm" "$1"
