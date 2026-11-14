#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ $# != 1 ]]; then
  echo 'Usage: modules/weather/tools/build-component.sh <output.wasm>' >&2
  exit 2
fi
target_dir="${WEATHER_GUEST_TARGET_DIR:-${CARGO_TARGET_DIR:-$PWD/modules/weather/src/target}}"
CARGO_TARGET_DIR="$target_dir" cargo +1.95.0 build --locked --offline --manifest-path modules/weather/src/Cargo.toml \
  --target wasm32-unknown-unknown --release
CARGO_TARGET_DIR="$target_dir/component-encoder" cargo +1.95.0 run --locked --offline \
  --manifest-path modules/weather/bindings/Cargo.toml \
  --bin weather-component -- \
  "$target_dir/wasm32-unknown-unknown/release/moss_weather_module.wasm" "$1"
