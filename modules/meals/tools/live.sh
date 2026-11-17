#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-meals-host}"
export CARGO_TARGET_DIR
modules/meals/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/meals/host/Cargo.toml --bin meals-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/meals.mosspkg"
export JS304_MEALS_PACKAGE="$CARGO_TARGET_DIR/meals.mosspkg"
pnpm exec tsx modules/meals/tools/live-gate.ts
