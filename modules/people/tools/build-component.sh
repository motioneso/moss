#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: build-component.sh output.wasm' >&2
  exit 2
fi
people_output=$(realpath -m -- "$1")
cd "$(dirname "$0")/../../.."
people_target=${CARGO_TARGET_DIR:-/tmp/moss-people-component-target}
people_target=$(realpath -m -- "$people_target")
people_flags=${CARGO_ENCODED_RUSTFLAGS:-}
if [[ -n ${MOSS_WASM_SYSROOT:-} ]]; then
  people_flags+="${people_flags:+$'\x1f'}--sysroot"$'\x1f'"$MOSS_WASM_SYSROOT"
fi
# The currently available target supplies the Rust core. The wrapper produces the
# actual Moss WIT component with only declared imports; it adds no WASI authority.
# A wasm32-wasip2 toolchain build is still a separate delivery requirement.
CARGO_TARGET_DIR="$people_target" CARGO_ENCODED_RUSTFLAGS="$people_flags" \
  cargo +1.95.0 rustc --locked --offline --manifest-path modules/people/src/Cargo.toml \
  --lib --features component --target wasm32-unknown-unknown --release -- \
  -C link-arg=--import-memory -C link-arg=--initial-memory=2097152 \
  -C link-arg=--max-memory=67108864
mkdir -p -- "$(dirname "$people_output")"
CARGO_TARGET_DIR="${MOSS_HOST_TARGET_DIR:-$people_target}" \
  cargo +1.95.0 run --locked --offline --manifest-path rust-spike/module-host/Cargo.toml \
  --example wrap_guest -- "$people_target/wasm32-unknown-unknown/release/moss_people.wasm" "$people_output"
