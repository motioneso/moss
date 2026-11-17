#!/usr/bin/env bash
# Live run of the Plaid probe on the real Rust server. Run through scripts/run-gate.sh.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-plaid-probe}"
export CARGO_TARGET_DIR
rust-spike/module-host/probes/plaid/build.sh "$CARGO_TARGET_DIR/plaid.wasm"
export JS295_PLAID_WASM="$CARGO_TARGET_DIR/plaid.wasm"
pnpm exec tsx rust-spike/module-host/probes/plaid/live-gate.ts
