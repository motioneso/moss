#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-integrations-host}"
export CARGO_TARGET_DIR
guest="$CARGO_TARGET_DIR/integrations-guest"
# Native tests of the pure sorting crate, replaying the stored old-code fixtures.
CARGO_TARGET_DIR="$guest" cargo +1.95.0 test --locked --offline --manifest-path rust-spike/integrations/Cargo.toml
# Stored fixtures must still equal what the old code produces.
pnpm exec tsx rust-spike/integrations/tools/sorting-oracle.ts check
pnpm exec tsx rust-spike/integrations/tools/host-oracle.ts check
# WebAssembly build, then the self-test and the host parity tests against it.
CARGO_TARGET_DIR="$guest" cargo +1.95.0 build --locked --offline --release --lib --features selftest \
  --target wasm32-unknown-unknown --manifest-path rust-spike/integrations/Cargo.toml
export INTEGRATIONS_CORE_WASM="$guest/wasm32-unknown-unknown/release/moss_integrations.wasm"
cargo +1.95.0 test --locked --offline --manifest-path rust-spike/integrations/host/Cargo.toml --test wasm --test parity
