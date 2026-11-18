#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-finance-host}"
export CARGO_TARGET_DIR
modules/finance/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/finance/host/Cargo.toml --bin finance-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/finance.mosspkg"
export JS302_FINANCE_PACKAGE="$CARGO_TARGET_DIR/finance.mosspkg"
export JS325_PLAID=1
pnpm exec tsx modules/finance/tools/live-gate.ts
