#!/usr/bin/env bash
# Rebuild from two source/Cargo/target directories using the same pinned toolchain.
set -euo pipefail
cd "$(dirname "$0")/../../.."
notes_root=$PWD
notes_cache=$(realpath -- "${MOSS_GUEST_CARGO_HOME:?Set the prepared scratch Cargo home}")
notes_rustup=$(realpath -- "${MOSS_GUEST_RUSTUP_HOME:?Set the prepared scratch Rust home}")
notes_host_target=$(realpath -m -- "${MOSS_HOST_TARGET_DIR:-/tmp/moss-notes-host-target}")
notes_repro=$(mktemp -d /tmp/moss-notes-repro.XXXXXXXX)
trap 'rm -rf -- "$notes_repro"' EXIT
for build in first second; do
  stage="$notes_repro/$build"
  mkdir -p "$stage/source/modules/notes/tools" "$stage/source/rust-spike/module-host" "$stage/cargo"
  cp -a modules/notes/src "$stage/source/modules/notes/"
  cp -a rust-spike/module-sdk "$stage/source/rust-spike/"
  cp -a rust-spike/module-host/wit "$stage/source/rust-spike/module-host/"
  cp modules/notes/tools/build-component.sh "$stage/source/modules/notes/tools/"
  cp -a "$notes_cache/registry" "$stage/cargo/"
  MOSS_GUEST_CARGO_HOME="$stage/cargo" MOSS_GUEST_RUSTUP_HOME="$notes_rustup" \
    CARGO_TARGET_DIR="$stage/target" \
    "$stage/source/modules/notes/tools/build-component.sh" --core-only "$stage/core.wasm"
  CARGO_TARGET_DIR="$notes_host_target" cargo +1.95.0 run --locked --offline \
    --manifest-path "$notes_root/rust-spike/module-host/Cargo.toml" \
    --example wrap_generated_guest -- "$stage/core.wasm" "$stage/notes.wasm"
  CARGO_TARGET_DIR="$notes_host_target" cargo +1.95.0 run --locked --offline \
    --manifest-path "$notes_root/modules/notes/tools/Cargo.toml" --bin notes-pack -- \
    "$stage/notes.wasm" "$stage/notes.mosspkg"
done
cmp "$notes_repro/first/notes.wasm" "$notes_repro/second/notes.wasm"
cmp "$notes_repro/first/notes.mosspkg" "$notes_repro/second/notes.mosspkg"
echo 'PASS rebuilt Notes components and archives are identical across two source, Cargo and target directories'
sha256sum "$notes_repro/first/notes.wasm" "$notes_repro/first/notes.mosspkg"
