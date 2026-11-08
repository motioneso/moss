#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ $# != 1 ]]; then
  echo 'Usage: modules/tasks/tools/build-component.sh <output.wasm>' >&2
  exit 2
fi
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/src/Cargo.toml \
  --target wasm32-unknown-unknown --release
tasks_target_dir="${CARGO_TARGET_DIR:-$PWD/modules/tasks/src/target}"
CARGO_TARGET_DIR="$tasks_target_dir/component-encoder" cargo +1.95.0 run --locked --offline \
  --manifest-path modules/tasks/bindings/Cargo.toml \
  --bin tasks-component -- \
  "$tasks_target_dir/wasm32-unknown-unknown/release/moss_tasks_module.wasm" "$1"
