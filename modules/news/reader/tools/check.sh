#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-news-reader}"
export CARGO_TARGET_DIR
reader=modules/news/reader

# Native: parity with the old reader, privacy proofs, library build.
cargo +1.95.0 test --locked --offline --manifest-path "$reader/Cargo.toml"

# WebAssembly: the library alone, then the same parity cases run inside the module under Node.
cargo +1.95.0 build --locked --offline --release --target wasm32-unknown-unknown \
  --manifest-path "$reader/Cargo.toml"
cargo +1.95.0 build --offline --release --target wasm32-unknown-unknown \
  --manifest-path "$reader/tools/wasm-check/Cargo.toml"
node "$reader/tools/wasm-check/run.mjs" \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/moss_news_reader_wasm_check.wasm"
