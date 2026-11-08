#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: modules/notes/tools/build-component.sh output.wasm' >&2
  exit 2
fi
notes_output=$(realpath -m -- "$1")
cd "$(dirname "$0")/../../.."
notes_target=$(realpath -m -- "${CARGO_TARGET_DIR:-/tmp/moss-notes-guest-target}")
notes_cargo=$(realpath -- "${MOSS_GUEST_CARGO_HOME:-${CARGO_HOME:-$HOME/.cargo}}")
notes_rustup=$(realpath -- "${MOSS_GUEST_RUSTUP_HOME:-${RUSTUP_HOME:-$HOME/.rustup}}")
notes_sysroot=$(RUSTUP_HOME="$notes_rustup" rustc +1.95.0 --print sysroot)
# Apply to every dependency, not just the final crate's cargo-rustc arguments.
printf -v notes_flags '%s\x1f' \
  --remap-path-prefix "$PWD=/moss/source" \
  --remap-path-prefix "$notes_cargo=/moss/cargo" \
  --remap-path-prefix "$notes_sysroot=/moss/rust" \
  --remap-path-prefix "$notes_target=/moss/target"
notes_flags=${notes_flags%$'\x1f'}
CARGO_HOME="$notes_cargo" RUSTUP_HOME="$notes_rustup" \
CARGO_ENCODED_RUSTFLAGS="$notes_flags" CARGO_TARGET_DIR="$notes_target" \
  cargo +1.95.0 rustc --locked --offline \
  --manifest-path modules/notes/src/Cargo.toml --lib --target wasm32-wasip2 --release -- \
  -C link-arg=--skip-wit-component -C link-arg=--import-memory \
  -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864
mkdir -p -- "$(dirname "$notes_output")"
notes_core="$notes_target/wasm32-wasip2/release/moss_notes.wasm"
CARGO_TARGET_DIR="${MOSS_HOST_TARGET_DIR:-$notes_target}" \
  cargo +1.95.0 run --locked --offline --manifest-path rust-spike/module-host/Cargo.toml \
  --example wrap_generated_guest -- "$notes_core" "$notes_output"
