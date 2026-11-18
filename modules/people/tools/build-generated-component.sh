#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: build-generated-component.sh output.wasm' >&2
  exit 2
fi
people_output=$(realpath -m -- "$1")
cd "$(dirname "$0")/../../.."
people_target=$(realpath -m -- "${CARGO_TARGET_DIR:-/tmp/moss-people-shipping-target}")
# Use a task-local rustup home with the declared wasm32-wasip2 target. The pinned
# generator is a project dependency, not a globally installed CLI.
CARGO_HOME="${MOSS_GUEST_CARGO_HOME:-${CARGO_HOME:-$HOME/.cargo}}" \
RUSTUP_HOME="${MOSS_GUEST_RUSTUP_HOME:-${RUSTUP_HOME:-$HOME/.rustup}}" \
CARGO_TARGET_DIR="$people_target" cargo +1.95.0 rustc --locked --offline \
  --manifest-path modules/people/src/Cargo.toml --lib --features generated-component \
  --target wasm32-wasip2 --release -- \
  -C link-arg=--skip-wit-component -C link-arg=--import-memory \
  -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864
mkdir -p -- "$(dirname "$people_output")"
CARGO_TARGET_DIR="${MOSS_HOST_TARGET_DIR:-$people_target}" \
  cargo +1.95.0 run --locked --offline --manifest-path rust-spike/module-host/Cargo.toml \
  --example wrap_generated_guest -- "$people_target/wasm32-wasip2/release/moss_people.wasm" "$people_output"
