#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: modules/notes/tools/build-component.sh output.wasm' >&2
  exit 2
fi
notes_output=$(realpath -m -- "$1")
cd "$(dirname "$0")/../../.."
notes_target=$(realpath -m -- "${CARGO_TARGET_DIR:-/tmp/moss-notes-guest-target}")
CARGO_HOME="${MOSS_GUEST_CARGO_HOME:-${CARGO_HOME:-$HOME/.cargo}}" \
RUSTUP_HOME="${MOSS_GUEST_RUSTUP_HOME:-${RUSTUP_HOME:-$HOME/.rustup}}" \
CARGO_TARGET_DIR="$notes_target" cargo +1.95.0 rustc --locked --offline \
  --manifest-path modules/notes/src/Cargo.toml --lib --target wasm32-wasip2 --release -- \
  -C link-arg=--skip-wit-component -C link-arg=--import-memory \
  -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864
mkdir -p -- "$(dirname "$notes_output")"
CARGO_TARGET_DIR="${MOSS_HOST_TARGET_DIR:-$notes_target}" \
  cargo +1.95.0 run --locked --offline --manifest-path rust-spike/module-host/Cargo.toml \
  --example wrap_generated_guest -- "$notes_target/wasm32-wasip2/release/moss_notes.wasm" "$notes_output"
